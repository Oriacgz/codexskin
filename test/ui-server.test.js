import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from 'node:http';
import { createUiServer } from "../src/core/ui-server.js";

// Note: paths.js dataDir() reads CODEXSKIN_HOME at call time, so switching the
// env per test gives each test an isolated store. CODEXSKIN_NO_LAUNCH=1 keeps
// tests hermetic on machines where the real Codex app IS installed - tests
// must never spawn the real application.
process.env.CODEXSKIN_NO_LAUNCH = "1";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function makeServer(options) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-ui-"));
  const oldHome = process.env.CODEXSKIN_HOME;
  process.env.CODEXSKIN_HOME = home;
  const { server, token, isQuitRequested, isTrayQuitRequested } = createUiServer(options);
  await listen(server);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/t/${token}/`;
  const cleanup = async () => {
    server.close();
    server.closeAllConnections();
    if (oldHome === undefined) delete process.env.CODEXSKIN_HOME;
    else process.env.CODEXSKIN_HOME = oldHome;
    await fs.rm(home, { recursive: true, force: true });
  };
  return { base, server, isQuitRequested, isTrayQuitRequested, cleanup, home };
}

// Note: paths.js captures CODEXSKIN_HOME at call time (dataDir() reads env per
// call), so per-test env switching works. Data dir module reads env lazily.
import { SAMPLE_THEMES, buildSampleThemeZip } from "../src/core/sample-themes.js";

test('ui: open-window invokes the actual window opener', async () => {
  const opened=[];
  const {base,cleanup}=await makeServer({openWindow:async url=>opened.push(url)});
  try {
    const result=await (await fetch(base+'open-window',{method:'POST'})).json();
    assert.equal(result.ok,true);
    assert.deepEqual(opened,[base+'app']);
  } finally {await cleanup();}
});

test('ui: polling over keep-alive does not accumulate socket listeners', async () => {
  const {base,server,cleanup}=await makeServer();
  const agent=new http.Agent({keepAlive:true,maxSockets:1});
  let socket;
  server.on('connection',connected=>{socket=connected;});
  const ping=()=>new Promise((resolve,reject)=>{
    http.get(base+'ping',{agent},response=>{response.resume();response.on('end',resolve);}).on('error',reject);
  });
  try {
    await ping();const initial=socket.listenerCount('error');
    for(let i=0;i<20;i++)await ping();
    assert.equal(socket.listenerCount('error'),initial);
  } finally {agent.destroy();await cleanup();}
});

test("ui: token gate - wrong token gets 404, correct token serves app", async () => {
  const { base, cleanup } = await makeServer();
  try {
    const bad = await fetch(`http://127.0.0.1:${new URL(base).port}/t/WRONG/app`);
    assert.equal(bad.status, 404);
    const good = await fetch(base + "app");
    assert.equal(good.status, 200);
    const html = await good.text();
    assert.ok(html.includes("codexskin"));
    assert.ok(html.includes("Import theme"));
  } finally {
    await cleanup();
  }
});

test("ui: state reports empty themes and codex discovery", async () => {
  const { base, cleanup } = await makeServer();
  try {
    const res = await fetch(base + "state");
    const state = await res.json();
    assert.deepEqual(state.themes, []);
    assert.equal(state.activeThemeId, null);
    assert.equal(typeof state.codexAppFound, "boolean");
    assert.equal(state.platform, process.platform);
  } finally {
    await cleanup();
  }
});

test("ui: import installs, auto-applies policy records theme as active even when renderer is absent", async () => {
  const { base, cleanup } = await makeServer();
  try {
    const zip = buildSampleThemeZip(SAMPLE_THEMES[0]);
    const res = await fetch(base + "import/" + encodeURIComponent("aurora.zip"), {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: zip,
    });
    const data = await res.json();
    // The mock renderer is not running and Codex is not installed here, so
    // auto-apply fails gracefully - but the theme must be installed and the
    // response must honestly report the apply error.
    assert.equal(data.ok, true);
    assert.equal(data.theme.id, "aurora-veil");
    assert.equal(data.installed, true);
    if (data.autoApplied !== true) {
      assert.match(data.applyError ?? "", /not found|not reachable|failed/i);
    }
    const state = await (await fetch(base + "state")).json();
    assert.equal(state.themes.length, 1);
    assert.equal(state.themes[0].id, "aurora-veil");
  } finally {
    await cleanup();
  }
});

test("ui: remove deletes the theme", async () => {
  const { base, cleanup } = await makeServer();
  try {
    await fetch(base + "import/" + encodeURIComponent("p.zip"), {
      method: "POST", headers: { "content-type": "application/zip" }, body: buildSampleThemeZip(SAMPLE_THEMES[1]),
    });
    const res = await fetch(base + "remove/paper-light", { method: "POST" });
    assert.equal((await res.json()).ok, true);
    const state = await (await fetch(base + "state")).json();
    assert.equal(state.themes.length, 0);
  } finally {
    await cleanup();
  }
});

test("ui: import with non-zip name is rejected", async () => {
  const { base, cleanup } = await makeServer();
  try {
    const res = await fetch(base + "import/theme.exe", {
      method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.from("MZ"),
    });
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.match(data.error, /zip/i);
  } finally {
    await cleanup();
  }
});

test("ui: quit endpoint flips the quit flag", async () => {
  const { base, isQuitRequested, cleanup } = await makeServer();
  try {
    await fetch(base + "quit", { method: "POST" });
    assert.equal(isQuitRequested(), true);
  } finally {
    await cleanup();
  }
});

test("ui: image endpoint serves theme background bytes", async () => {
  const { base, cleanup } = await makeServer();
  try {
    await fetch(base + "import/" + encodeURIComponent("a.zip"), {
      method: "POST", headers: { "content-type": "application/zip" }, body: buildSampleThemeZip(SAMPLE_THEMES[0]),
    });
    const res = await fetch(base + "image/aurora-veil");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /image\/png/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 1000);
  } finally {
    await cleanup();
  }
});

test("ui: state reports codexRunning and autostartEnabled fields", async () => {
  const { base, cleanup } = await makeServer();
  try {
    const state = await (await fetch(base + "state")).json();
    assert.equal(typeof state.codexRunning, "boolean");
    assert.equal(typeof state.autostartEnabled, "boolean");
    assert.equal(typeof state.codexReachable, "boolean");
  } finally {
    await cleanup();
  }
});

test("ui: launch-codex honors the CODEXSKIN_NO_LAUNCH kill-switch", async () => {
  const { base, cleanup } = await makeServer();
  try {
    const res = await fetch(base + "launch-codex", { method: "POST" });
    const data = await res.json();
    // Hermetic tests must never spawn the real app: the launch must be
    // refused with an honest error (Codex may genuinely be installed here).
    assert.equal(data.ok, false);
    assert.match(data.error, /disabled|not found|not reachable/i);
  } finally {
    await cleanup();
  }
});

test("ui: apply-active without themes reports an actionable error", async () => {
  const { base, cleanup } = await makeServer();
  try {
    const res = await fetch(base + "apply-active", { method: "POST" });
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.match(data.error, /no theme installed/i);
  } finally {
    await cleanup();
  }
});

test("ui: autostart route validates its action", async () => {
  const { base, cleanup } = await makeServer();
  try {
    const res = await fetch(base + "autostart/sometimes", { method: "POST" });
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.match(data.error, /enable\|disable/);
  } finally {
    await cleanup();
  }
});

test("ui: window heartbeat records fresh beats and retires stale tokens", async () => {
  const { base, cleanup } = await makeServer();
  try {
    const beat = async (since) => {
      const res = await fetch(base + "window-heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ since }),
      });
      return res.json();
    };
    // Unknown token (-1) is stale once, then the page syncs to token 0.
    assert.equal((await beat(-1)).stale, true);
    assert.equal((await beat(-1)).token, 0);
    const fresh = await beat(0);
    assert.equal(fresh.stale, false);
    // open-window bumps the token: old windows read as stale afterwards.
    const opened = await (await fetch(base + "open-window", { method: "POST" })).json();
    assert.equal(opened.ok, true);
    assert.match(opened.url, /\/app$/);
    assert.equal((await beat(0)).stale, true);
    assert.equal((await beat(1)).stale, false);
  } finally {
    await cleanup();
  }
});

test("ui: quit flips both the window and tray quit flags", async () => {
  const { base, isQuitRequested, isTrayQuitRequested, cleanup } = await makeServer();
  try {
    await fetch(base + "quit", { method: "POST" });
    assert.equal(isQuitRequested(), true);
    assert.equal(isTrayQuitRequested(), true);
  } finally {
    await cleanup();
  }
});

test("ui: apply/<id> with restart body still reports honest failures", async () => {
  const { base, cleanup } = await makeServer();
  try {
    await fetch(base + "import/" + encodeURIComponent("a.zip"), {
      method: "POST", headers: { "content-type": "application/zip" }, body: buildSampleThemeZip(SAMPLE_THEMES[0]),
    });
    const res = await fetch(base + "apply/aurora-veil", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ restart: true }),
    });
    const data = await res.json();
    // Under the NO_LAUNCH kill-switch the apply cannot reach a renderer; the
    // important part is an honest failure, never a fake success.
    if (data.ok !== true) assert.match(data.error ?? "", /not reachable|disabled|not found|failed/i);
  } finally {
    await cleanup();
  }
});

test('ui: blocks foreign origins, rebinding hosts, and framing', async () => {
  const {base, cleanup, isQuitRequested} = await makeServer();
  try {
    const app = await fetch(base+'app');
    assert.equal(app.headers.get('x-frame-options'), 'DENY');
    assert.equal(app.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(app.headers.get('x-content-type-options'), 'nosniff');
    const html = await app.text();
    const {createHash} = await import('node:crypto');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const hash = createHash('sha256').update(script).digest('base64');
    assert.ok(app.headers.get('content-security-policy').includes(`'sha256-${hash}'`));
    assert.equal((await fetch(base+'quit', {method:'POST', headers:{origin:'https://evil.example'}})).status, 403);
    assert.equal((await fetch(base+'quit', {method:'POST', headers:{'sec-fetch-site':'cross-site'}})).status, 403);
    const hostileHostStatus = await new Promise((resolve, reject) => {
      const request = http.get(base+'ping', {headers:{host:'evil.example'}}, response => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on('error', reject);
    });
    assert.equal(hostileHostStatus, 403);
    assert.equal(isQuitRequested(), false);
    assert.equal((await fetch(base+'ping', {headers:{origin:new URL(base).origin}})).status, 200);
  } finally {await cleanup();}
});

test('ui: preview rejects tampered installed images', async () => {
  const {base, home, cleanup} = await makeServer();
  try {
    const theme = SAMPLE_THEMES[0];
    await fetch(base+'import/sample.zip', {method:'POST', body:buildSampleThemeZip(theme)});
    const image = await fetch(base+'image/'+theme.id);
    assert.equal(image.headers.get('content-type'), 'image/png');
    await image.arrayBuffer();
    await fs.writeFile(path.join(home,'themes',theme.id,'background.png'), 'tampered');
    const rejected = await (await fetch(base+'image/'+theme.id)).json();
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /checksum/);
  } finally {await cleanup();}
});

test('ui: codextheme imports use the same validated archive path', async()=>{
 const {base,cleanup}=await makeServer();
 try{
  const imported=await (await fetch(base+'import/example.codextheme',{method:'POST',body:buildSampleThemeZip(SAMPLE_THEMES[0])})).json();
  assert.equal(imported.ok,true);
  assert.equal(imported.theme.id,SAMPLE_THEMES[0].id);
  const corrupt=await (await fetch(base+'import/corrupt.codextheme',{method:'POST',body:'not an archive'})).json();
  assert.equal(corrupt.ok,false);assert.match(corrupt.error,/zip/);
 }finally{await cleanup();}
});
