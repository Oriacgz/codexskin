// Mock Codex renderer: a fake CDP endpoint for testing codexskin without the
// real app. Answers /json/list and Runtime.evaluate the way the real renderer
// would for the codexskin payload contract (apply / verify / restore).
//
// Usage:
//   node tools/mock-codex.mjs                 # port 9223 (the default debug port)
//   node tools/mock-codex.mjs --port 9333 --skin off --crash-after 5
//
// The mock keeps in-memory DOM state:
//   skinInstalled, skinThemeId, layerHeight, documentHidden, crashInEvaluations
// and evaluates the *actual* payload expressions against that state, so the
// real CLI is exercised against a faithful contract implementation.

import http from "node:http";
import { createHash } from "node:crypto";
import process from "node:process";

const args = process.argv.slice(2);
function flagValue(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}
function flagBool(name) {
  return args.includes(name);
}

const PORT = Number(flagValue("--port", "9223"));
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// --- Fake renderer state ---------------------------------------------------

const state = {
  skinInstalled: flagBool("--skin-on"),
  skinThemeId: null,
  layerHeight: 900,
  documentHidden: flagBool("--hidden"),
  crashInEvaluations: Number(flagValue("--crash-after", "0")), // 0 = never
  evaluations: 0,
  lastError: null,
};

// --- WebSocket framing (server side, unmasked writes) -----------------------

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65_536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

// --- Fake DOM: evaluate the payload contract against state ------------------

function evaluateExpression(expression) {
  // Detect which contract function the expression is and emulate its result
  // against the fake DOM state. The real renderer executes these as JS; we
  // implement the contract's observable behavior.
  if (expression.includes("document.documentElement.setAttribute")) {
    // apply expression
    const idMatch = /"data-codexskin-theme",\s*"([^"]+)"/.exec(expression) ?? /THEME\.id/.test(expression) ? /"id":"([^"]+)"/.exec(expression) : null;
    const id = idMatch ? idMatch[1] : null;
    state.skinInstalled = true;
    state.skinThemeId = id;
    state.layerHeight = 900;
    return { ok: true, themeId: id };
  }
  if (expression.includes('"data-codexskin"') && expression.includes("getAttribute")) {
    // verify expression: reads attributes and layer height. The expected theme
    // id appears as getAttribute("data-codexskin-theme") === "<id>".
    const expectedId = /getAttribute\("data-codexskin-theme"\)\s*===\s*"([^"]+)"/.exec(expression)?.[1] ?? null;
    const active = state.skinInstalled;
    const themeId = state.skinThemeId;
    const themeMatches = active && expectedId !== null ? themeId === expectedId : Boolean(themeId);
    const layerVisible = state.layerHeight > 0 && !state.documentHidden;
    const styleAttached = active;
    return {
      active,
      themeId,
      themeMatches,
      layerVisible,
      styleAttached,
      ok: active && themeMatches && layerVisible && styleAttached,
    };
  }
  if (expression.includes("removeAttribute")) {
    // restore expression
    const removed = state.skinInstalled ? 3 : 0;
    state.skinInstalled = false;
    state.skinThemeId = null;
    return { ok: true, removed };
  }
  return { ok: false, unknown: true };
}

// --- HTTP + WebSocket server -------------------------------------------------

const server = http.createServer((req, res) => {
  if (req.url === "/json/list" || req.url === "/json") {
    const payload = [{
      id: "mock-page-1",
      type: "page",
      title: "Codex (mock)",
      url: "https://codex.openai.com/",
      webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/page/mock-page-1`,
    }];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  let buf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) break;
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) break;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) break;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const mask = buf.subarray(off, off + 4);
      off += 4;
      if (buf.length < off + len) break;
      const payload = Buffer.from(buf.subarray(off, off + len));
      for (let i = 0; i < len; i += 1) payload[i] ^= mask[i % 4];
      buf = buf.subarray(off + len);

      if (opcode === 0x8) {
        socket.end();
        return;
      }
      if (opcode === 0x9) {
        socket.write(encodeFrame(0xA, payload)); // ping -> pong
        continue;
      }
      if (opcode !== 0x1) continue;

      let msg;
      try {
        msg = JSON.parse(payload.toString("utf8"));
      } catch {
        continue;
      }
      state.evaluations += 1;
      if (state.crashInEvaluations > 0 && state.evaluations > state.crashInEvaluations) {
        socket.destroy();
        return;
      }
      let result;
      try {
        const value = evaluateExpression(msg.params?.expression ?? "");
        result = { id: msg.id, result: { result: { type: "object", value } } };
      } catch (error) {
        result = { id: msg.id, result: { exceptionDetails: { text: String(error) } } };
      }
      socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(result))));
    }
  });

  socket.on("error", () => {});
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock codex renderer listening on 127.0.0.1:${PORT}`);
  console.log(`  skin: ${state.skinInstalled ? "on" : "off"}, hidden: ${state.documentHidden}`);
  if (state.crashInEvaluations > 0) console.log(`  will drop connection after ${state.crashInEvaluations} evaluations`);
});

process.on("SIGINT", () => process.exit(0));
