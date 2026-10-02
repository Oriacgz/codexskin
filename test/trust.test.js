import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildSignatureEnvelope,
  generateSigningKeyPair,
  loadTrustedKeys,
  parseSignatureEnvelope,
  verifyEnvelopeBytes,
} from "../src/core/trust.js";

test("keygen produces valid ed25519 pem pair", () => {
  const { publicKeyPem, privateKeyPem } = generateSigningKeyPair();
  assert.match(publicKeyPem, /BEGIN PUBLIC KEY/);
  assert.match(privateKeyPem, /PRIVATE KEY/);
});

test("envelope round trip: build -> parse -> verify", () => {
  const { publicKeyPem, privateKeyPem } = generateSigningKeyPair();
  const manifest = Buffer.from(JSON.stringify({ packageVersion: 1, hello: "world" }));
  const envelope = buildSignatureEnvelope(manifest, privateKeyPem, "test-key");
  const parsed = parseSignatureEnvelope(envelope);
  assert.equal(parsed.keyId, "test-key");
  assert.ok(parsed.signedBytes.equals(manifest));
  verifyEnvelopeBytes(parsed, manifest, createPublicKey(publicKeyPem));
});

test("envelope rejects wrong key", () => {
  const a = generateSigningKeyPair();
  const b = generateSigningKeyPair();
  const manifest = Buffer.from("manifest bytes");
  const envelope = buildSignatureEnvelope(manifest, a.privateKeyPem, "k");
  const parsed = parseSignatureEnvelope(envelope);
  assert.throws(() => verifyEnvelopeBytes(parsed, manifest, createPublicKey(b.publicKeyPem)), /not valid/);
});

test("envelope rejects manifest byte mismatch", () => {
  const { publicKeyPem, privateKeyPem } = generateSigningKeyPair();
  const envelope = buildSignatureEnvelope(Buffer.from("aaa"), privateKeyPem, "k");
  const parsed = parseSignatureEnvelope(envelope);
  assert.throws(() => verifyEnvelopeBytes(parsed, Buffer.from("bbb"), createPublicKey(publicKeyPem)), /does not match/);
});

test("envelope rejects tampered signed payload with valid key", () => {
  const { publicKeyPem, privateKeyPem } = generateSigningKeyPair();
  const manifest = Buffer.from("real manifest");
  const envelope = buildSignatureEnvelope(manifest, privateKeyPem, "k");
  const parsed = parseSignatureEnvelope(envelope);
  const forged = Buffer.from("fake manifest");
  assert.throws(() => verifyEnvelopeBytes(parsed, forged, createPublicKey(publicKeyPem)), /does not match/);
});

test("envelope rejects non-ed25519 algorithm and bad schema", () => {
  const bad1 = Buffer.from(JSON.stringify({ schema: "codexskin-signature/1", keyId: "k", algorithm: "rsa", signed: "QQ==", signature: "QQ" }));
  assert.throws(() => parseSignatureEnvelope(bad1), /algorithm/);
  const bad2 = Buffer.from(JSON.stringify({ schema: "other/1", keyId: "k", algorithm: "ed25519", signed: "QQ==", signature: "QQ" }));
  assert.throws(() => parseSignatureEnvelope(bad2), /schema/);
});

test("envelope rejects wrong signature length", () => {
  const { privateKeyPem } = generateSigningKeyPair();
  const manifest = Buffer.from("m");
  const good = JSON.parse(buildSignatureEnvelope(manifest, privateKeyPem, "k").toString());
  good.signature = Buffer.from("y").toString("base64");
  assert.throws(() => parseSignatureEnvelope(Buffer.from(JSON.stringify(good))), /64 bytes/);
});

test("trusted-keys loader: named and unnamed keys, comments", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-trust-"));
  try {
    const { publicKeyPem } = generateSigningKeyPair();
    const other = generateSigningKeyPair();
    const file = path.join(dir, "trusted-keys.pem");
    await fs.writeFile(file, [
      "# codexskin trusted keys",
      `keyId: alpha`,
      publicKeyPem.trim(),
      "",
      other.publicKeyPem.trim(),
      "",
    ].join("\n"));
    const keys = await loadTrustedKeys(file);
    assert.equal(keys.size, 2);
    assert.ok(keys.has("alpha"));
    assert.ok([...keys.keys()].includes("key-2"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("trusted-keys loader: missing file fails", async () => {
  await assert.rejects(() => loadTrustedKeys(path.join(os.tmpdir(), "does-not-exist-cs.pem")), /not found/);
});

test("trusted-keys loader: non-ed25519 key rejected", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-trust-"));
  try {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const file = path.join(dir, "k.pem");
    await fs.writeFile(file, rsaPem);
    await assert.rejects(() => loadTrustedKeys(file), /not an ed25519/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("trusted-keys loader: keyId line without body fails", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-trust-"));
  try {
    const file = path.join(dir, "k.pem");
    await fs.writeFile(file, "keyId: orphan\n# nothing follows\n");
    await assert.rejects(() => loadTrustedKeys(file), /no key body|has no PEM/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
