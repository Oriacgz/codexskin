import assert from "node:assert/strict";
import { createHash, createPublicKey } from "node:crypto";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importThemePackage } from "../src/core/package.js";
import { SAMPLE_THEMES, buildSampleThemeZip, buildZip } from "../src/core/sample-themes.js";
import { readZip } from "../src/core/zip.js";
import { encodePng, gradientBackground } from "../src/core/png.js";
import {
  buildSignatureEnvelope,
  generateSigningKeyPair,
  loadTrustedKeys,
  parseSignatureEnvelope,
  verifyEnvelopeBytes,
} from "../src/core/trust.js";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function makeImage() {
  return encodePng(64, 36, gradientBackground(64, 36, { from: "#000000", to: "#ffffff" }));
}

function buildOfficialPackage({
  imageBytes,
  cssText = "sidebar { background-color: rgba(16, 16, 20, 0.5); }",
  manifestOverrides = {},
  themeOverrides = {},
  extraEntries = [],
  omitSig = false,
} = {}) {
  const image = imageBytes ?? makeImage();
  const entries = new Map();
  const theme = {
    schemaVersion: 1,
    id: "signed-theme",
    name: "Signed Theme",
    image: "background.png",
    appearance: "dark",
    tagline: "Signed test theme",
    colors: { background: "#101014", accent: "#7c3aed", text: "#f5f3ff", muted: "#a5a3ae", line: "rgba(124,58,237,0.3)" },
    ...themeOverrides,
  };
  entries.set("theme.json", Buffer.from(JSON.stringify(theme)));
  entries.set(theme.image, image);
  entries.set("theme.css", Buffer.from(cssText, "utf8"));
  for (const [k, v] of extraEntries) entries.set(k, v);

  const media = (n) => (n === "theme.json" ? "application/json"
    : n === "theme.css" ? "text/css"
    : n === "LICENSE.txt" ? "text/plain"
    : n.endsWith(".png") ? "image/png"
    : n.endsWith(".webp") ? "image/webp" : "image/jpeg");
  const files = [...entries.entries()]
    .map(([p, bytes]) => ({ path: p, mediaType: media(p), bytes: bytes.length, sha256: sha256(bytes) }));
  const manifest = {
    packageVersion: 1,
    themeId: theme.id,
    version: "1.0.0",
    skinApiVersion: 1,
    minClientVersion: "1.5.0",
    platforms: ["macos", "windows"],
    capabilities: ["background", "tokens", "safe-css"],
    publisher: { id: "tester", displayName: "Tester" },
    license: "MIT",
    provenance: { aiGenerated: true, summary: "Signed test package." },
    createdAt: "2026-10-01T00:00:00Z",
    files,
    ...manifestOverrides,
  };
  entries.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
  return buildZip(entries);
}

async function withTrustedKeys(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-sig-"));
  try {
    const kp = generateSigningKeyPair();
    const keysFile = path.join(dir, "trusted-keys.pem");
    await fs.writeFile(keysFile, `keyId: acme-signing\n${kp.publicKeyPem.trim()}\n`);
    const keys = await loadTrustedKeys(keysFile);
    return run({ keys, privateKeyPem: kp.privateKeyPem, publicKeyPem: kp.publicKeyPem, dir });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function signPackage(zipBuffer, privateKeyPem, keyId) {
  const files = readZip(zipBuffer);
  const envelope = buildSignatureEnvelope(files.get("manifest.json"), privateKeyPem, keyId);
  files.set("manifest.sig", envelope);
  return buildZip(files);
}

test("signed package imports and reports verified signature", async () => {
  await withTrustedKeys(async ({ keys, privateKeyPem }) => {
    const unsigned = buildOfficialPackage();
    const signed = signPackage(unsigned, privateKeyPem, "acme-signing");
    const pkg = importThemePackage(signed, { trustedKeys: keys });
    assert.equal(pkg.meta.signature.verified, true);
    assert.equal(pkg.meta.signature.keyId, "acme-signing");
    assert.equal(pkg.theme.id, "signed-theme");
  });
});

test("signed package fails when manifest is tampered after signing", async () => {
  await withTrustedKeys(async ({ keys, privateKeyPem }) => {
    const unsigned = buildOfficialPackage();
    const signedZip = readZip(signPackage(unsigned, privateKeyPem, "acme-signing"));
    // Tamper the manifest AFTER signing: bump version in place.
    const manifest = JSON.parse(signedZip.get("manifest.json").toString());
    manifest.version = "2.0.0";
    signedZip.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
    const resealed = buildZip(signedZip);
    assert.throws(
      () => importThemePackage(resealed, { trustedKeys: keys }),
      /signed payload does not match/,
    );
  });
});

test("signed package fails when signature bytes are tampered", async () => {
  await withTrustedKeys(async ({ keys, privateKeyPem }) => {
    const unsigned = buildOfficialPackage();
    const files = readZip(signPackage(unsigned, privateKeyPem, "acme-signing"));
    const env = JSON.parse(files.get("manifest.sig").toString());
    const sig = Buffer.from(env.signature, "base64");
    sig[0] ^= 0xff;
    env.signature = sig.toString("base64");
    files.set("manifest.sig", Buffer.from(JSON.stringify(env)));
    assert.throws(
      () => importThemePackage(buildZip(files), { trustedKeys: keys }),
      /not valid for any trusted key|does not match/,
    );
  });
});

test("signed package fails with unknown keyId", async () => {
  await withTrustedKeys(async ({ keys, privateKeyPem }) => {
    const unsigned = buildOfficialPackage();
    const signed = signPackage(unsigned, privateKeyPem, "rogue-key");
    assert.throws(
      () => importThemePackage(signed, { trustedKeys: keys }),
      /not in the trusted-keys file/,
    );
  });
});

test("signed package fails when signed with untrusted key under known keyId", async () => {
  await withTrustedKeys(async ({ keys }) => {
    const rogue = generateSigningKeyPair();
    const unsigned = buildOfficialPackage();
    const signed = signPackage(unsigned, rogue.privateKeyPem, "acme-signing");
    assert.throws(
      () => importThemePackage(signed, { trustedKeys: keys }),
      /not valid for any trusted key/,
    );
  });
});

test("requireSignature refuses unsigned package", async () => {
  await withTrustedKeys(async ({ keys }) => {
    const unsigned = buildOfficialPackage();
    assert.throws(
      () => importThemePackage(unsigned, { trustedKeys: keys, requireSignature: true }),
      /no manifest.sig/,
    );
  });
});

test("requireSignature with wrong key file fails on missing file", async () => {
  await assert.rejects(
    () => loadTrustedKeys(path.join(os.tmpdir(), "cs-missing-keys.pem")),
    /not found/,
  );
});

test("envelope self-check inside signPackage matches verification", async () => {
  const kp = generateSigningKeyPair();
  const manifest = Buffer.from(JSON.stringify({ packageVersion: 1 }));
  const envelope = buildSignatureEnvelope(manifest, kp.privateKeyPem, "k");
  const parsed = parseSignatureEnvelope(envelope);
  verifyEnvelopeBytes(parsed, manifest, createPublicKey(kp.publicKeyPem));
});

test("simple packages are unaffected by signature options", async () => {
  await withTrustedKeys(async ({ keys }) => {
    const pkg = importThemePackage(buildSampleThemeZip(SAMPLE_THEMES[0]), {
      trustedKeys: keys,
      requireSignature: true,
    });
    assert.equal(pkg.meta.source, "codexskin-simple");
    assert.equal(pkg.meta.signature, undefined);
  });
});
