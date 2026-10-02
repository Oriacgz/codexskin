// Tests for the CDP client, exercised against an in-process mock CDP endpoint.
// The mock answers /json/list, performs the WebSocket handshake, and replies to
// Runtime.evaluate commands with canned results - enough to prove framing,
// handshake, request/response correlation, and error paths.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import http from "node:http";
import { connectCdp, listTargets } from "../src/core/cdp.js";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeServerFrame(opcode, payload) {
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

function createMockCdp({ targets } = {}) {
  const requests = [];
  let wsSocket = null;
  const handlers = [];

  const server = http.createServer((req, res) => {
    if (req.url === "/json/list") {
      const port = server.address().port;
      const list = targets
        ?? [{
          id: "page-1",
          type: "page",
          title: "Codex",
          url: "https://codex.openai.com/",
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1`,
        }];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(list));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on("upgrade", (req, socket) => {
    wsSocket = socket;
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
        if (opcode === 0x8) { socket.end(); return; }
        if (opcode === 0x1) {
          const msg = JSON.parse(payload.toString("utf8"));
          requests.push(msg);
          for (const handler of handlers) handler(msg, (reply) => {
            socket.write(encodeServerFrame(0x1, Buffer.from(JSON.stringify(reply))));
          });
        }
      }
    });
  });

  function respond(handler) {
    handlers.push(handler);
  }

  function close() {
    if (wsSocket) wsSocket.destroy();
    server.close();
    server.closeAllConnections();
  }

  return { server, respond, requests, close,
    rawWrite(bytes) { wsSocket.write(bytes); },
    disconnect() { wsSocket.destroy(); },
  };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

test("listTargets returns parsed target list", async () => {
  const mock = createMockCdp();
  const port = await listen(mock.server);
  try {
    const targets = await listTargets(port);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].type, "page");
  } finally {
    mock.close();
  }
});

test("connectCdp performs handshake and correlates evaluate responses", async () => {
  const mock = createMockCdp();
  const port = await listen(mock.server);
  try {
    mock.respond((msg, reply) => {
      if (msg.method === "Runtime.evaluate") {
        reply({ id: msg.id, result: { result: { type: "object", value: { ok: true, themeId: "x" } } } });
      }
    });
    const cdp = await connectCdp(port);
    try {
      const value = await cdp.evaluate("1+1");
      assert.deepEqual(value, { ok: true, themeId: "x" });
    } finally {
      cdp.close();
    }
  } finally {
    mock.close();
  }
});

test("connectCdp surfaces page exceptions", async () => {
  const mock = createMockCdp();
  const port = await listen(mock.server);
  try {
    mock.respond((msg, reply) => {
      if (msg.method === "Runtime.evaluate") {
        reply({
          id: msg.id,
          result: {
            exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: nope is not defined" } },
          },
        });
      }
    });
    const cdp = await connectCdp(port);
    try {
      await assert.rejects(() => cdp.evaluate("nope"), /nope is not defined/);
    } finally {
      cdp.close();
    }
  } finally {
    mock.close();
  }
});

test("connectCdp rejects when the debugger reports an error", async () => {
  const mock = createMockCdp();
  const port = await listen(mock.server);
  try {
    mock.respond((msg, reply) => {
      if (msg.method === "Runtime.evaluate") {
        reply({ id: msg.id, error: { message: "Cannot evaluate on this target" } });
      }
    });
    const cdp = await connectCdp(port);
    try {
      await assert.rejects(() => cdp.evaluate("1"), /Cannot evaluate/);
    } finally {
      cdp.close();
    }
  } finally {
    mock.close();
  }
});

test("connectCdp survives payload larger than 64 KiB (multi-frame-length)", async () => {
  const mock = createMockCdp();
  const port = await listen(mock.server);
  try {
    const bigString = "x".repeat(200_000);
    mock.respond((msg, reply) => {
      if (msg.method === "Runtime.evaluate") {
        reply({ id: msg.id, result: { result: { type: "string", value: bigString } } });
      }
    });
    const cdp = await connectCdp(port);
    try {
      const value = await cdp.evaluate("big");
      assert.equal(value.length, 200_000);
    } finally {
      cdp.close();
    }
  } finally {
    mock.close();
  }
});

test('CDP handles continuation frames and rejects after local close', async () => {
  const mock = createMockCdp();
  const port = await listen(mock.server);
  const cdp = await connectCdp(port);
  try {
    mock.respond(msg => {
      const bytes = Buffer.from(JSON.stringify({ id: msg.id, result: { result: { value: 'fragmented' } } }));
      const first = encodeServerFrame(1, bytes.subarray(0, 17));
      first[0] = 1; // FIN off; text starts here and continues in opcode 0.
      mock.rawWrite(Buffer.concat([first, encodeServerFrame(0, bytes.subarray(17))]));
    });
    assert.equal(await cdp.evaluate('1'), 'fragmented');
    cdp.close();
    await assert.rejects(cdp.send('Runtime.evaluate'), /connection closed/);
  } finally { cdp.close(); mock.close(); }
});

test('CDP rejects pending work when peer disconnects', async () => {
  const mock = createMockCdp();
  const port = await listen(mock.server);
  const cdp = await connectCdp(port, { timeoutMs: 1000 });
  try {
    mock.respond(() => mock.disconnect());
    await assert.rejects(cdp.evaluate('1'), /connection closed|connection error/);
  } finally { cdp.close(); mock.close(); }
});
