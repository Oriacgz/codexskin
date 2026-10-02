// Ed25519 signature verification for official DreamSkin packages.
//
// Envelope (manifest.sig), contract "codexskin-signature/1":
//   { "schema": "codexskin-signature/1", "keyId": "...", "algorithm": "ed25519",
//     "signed": "<base64 of the exact manifest.json bytes>",
//     "signature": "<base64 ed25519 signature over those bytes>" }
//
// The signed payload is the raw manifest.json byte string - not a re-serialized
// copy - so the envelope stays format-agnostic and the manifest's own bytes are
// exactly what was signed.
//
// Trust store: a user-managed trusted-keys file (PEM SPKI per line, or
// "keyId: <PEM SPKI>"). Fail closed: no file, no match, or bad envelope means
// "unverified", and callers decide what that means (import refuses when
// signatures are required).

import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";

export const SIGNATURE_SCHEMA = "codexskin-signature/1";
const MAX_ENVELOPE_BYTES = 4096;
const MAX_TRUSTED_KEYS_BYTES = 256 * 1024;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function fail(message) {
  throw new Error(`signature: ${message}`);
}

function decodeBase64(value, label) {
  if (typeof value !== "string" || !BASE64_PATTERN.test(value)) fail(`${label} is not base64`);
  const buffer = Buffer.from(value, "base64");
  if (buffer.length === 0) fail(`${label} is empty`);
  return buffer;
}

// --- Trusted keys file -------------------------------------------------------

/**
 * Load the trusted-keys file. Format: one PEM SPKI public key per block,
 * optionally preceded by a "keyId: <id>" line naming it. Comment lines start
 * with '#'. Returns Map<keyId, KeyObject>; unnamed keys get ids "key-1", ...
 */
export async function loadTrustedKeys(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") fail(`trusted-keys file not found: ${filePath}`);
    fail(`cannot read trusted-keys file: ${error?.message ?? error}`);
  }
  if (text.length > MAX_TRUSTED_KEYS_BYTES) fail("trusted-keys file too large");
  if (text.includes("\0")) fail("trusted-keys file contains NUL bytes");

  const keys = new Map();
  let current = [];
  let currentId = null;
  let counter = 0;

  const flush = () => {
    if (current.length === 0) {
      if (currentId !== null) fail(`keyId ${currentId} has no PEM key body`);
      return;
    }
    counter += 1;
    const id = currentId ?? `key-${counter}`;
    if (keys.has(id)) fail(`duplicate keyId in trusted keys: ${id}`);
    let key;
    try {
      key = createPublicKey(current.join("\n"));
    } catch {
      fail(`invalid PEM public key in trusted-keys file (keyId ${id})`);
    }
    if (key.asymmetricKeyType !== "ed25519") fail(`key ${id} is not an ed25519 key`);
    keys.set(id, key);
    current = [];
    currentId = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^keyId\s*:/i.test(line)) {
      if (currentId !== null && current.length === 0) {
        fail(`repeated keyId line with no key body: ${line}`);
      }
      flush();
      currentId = line.replace(/^keyId\s*:/i, "").trim();
      if (!KEY_ID_PATTERN.test(currentId)) fail(`invalid keyId in trusted keys: ${currentId}`);
      continue;
    }
    current.push(line);
    if (line.endsWith("-----END PUBLIC KEY-----")) flush();
  }
  flush();

  if (keys.size === 0) fail("trusted-keys file contains no usable ed25519 public keys");
  return keys;
}

// --- Envelope ----------------------------------------------------------------

/**
 * Parse and structurally validate a manifest.sig envelope (no trust decisions).
 */
export function parseSignatureEnvelope(bytes) {
  if (bytes.length < 1 || bytes.length > MAX_ENVELOPE_BYTES) fail("signature envelope size out of bounds");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("signature envelope is not valid UTF-8");
  }
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    fail("signature envelope is not valid JSON");
  }
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    fail("signature envelope must be an object");
  }
  if (envelope.schema !== SIGNATURE_SCHEMA) fail(`unsupported signature schema: ${envelope.schema}`);
  if (envelope.algorithm !== "ed25519") fail(`unsupported signature algorithm: ${envelope.algorithm}`);
  if (typeof envelope.keyId !== "string" || !KEY_ID_PATTERN.test(envelope.keyId)) {
    fail("signature envelope has an invalid keyId");
  }
  const signed = decodeBase64(envelope.signed, "envelope.signed");
  const signature = decodeBase64(envelope.signature, "envelope.signature");
  if (signature.length !== 64) fail("ed25519 signature must be 64 bytes");
  return { keyId: envelope.keyId, signedBytes: signed, signatureBytes: signature, raw: envelope };
}

/**
 * Build a signature envelope over exact manifest bytes with a private key.
 */
export function buildSignatureEnvelope(manifestBytes, privateKeyPem, keyId) {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") fail("private key must be ed25519");
  if (typeof keyId !== "string" || !KEY_ID_PATTERN.test(keyId)) fail("invalid keyId");
  const signature = edSign(null, manifestBytes, privateKey);
  return Buffer.from(JSON.stringify({
    schema: SIGNATURE_SCHEMA,
    keyId,
    algorithm: "ed25519",
    signed: manifestBytes.toString("base64"),
    signature: signature.toString("base64"),
  }, null, 2));
}

// --- Verification --------------------------------------------------------------

/**
 * Verify the envelope's embedded bytes against the manifest bytes and a
 * trusted key. Returns { keyId } on success; throws on any mismatch.
 */
export function verifyEnvelopeBytes(envelope, manifestBytes, trustedKey) {
  if (!envelope.signedBytes.equals(manifestBytes)) {
    fail("signed payload does not match manifest.json bytes");
  }
  const ok = edVerify(null, manifestBytes, trustedKey, envelope.signatureBytes);
  if (!ok) fail("ed25519 signature is not valid for any trusted key");
  return { keyId: envelope.keyId };
}

/**
 * Generate an ed25519 keypair for package signing.
 * Returns { publicKeyPem, privateKeyPem }.
 */
export function generateSigningKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}
