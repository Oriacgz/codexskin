import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { readZip } from "../src/core/zip.js";
import { importThemePackage } from "../src/core/package.js";
import { SAMPLE_THEMES, buildSampleThemeZip, buildZip } from "../src/core/sample-themes.js";
import { encodePng, gradientBackground } from "../src/core/png.js";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function makePng() {
  return encodePng(64, 36, gradientBackground(64, 36, { from: "#000000", to: "#ffffff" }));
}

function makeJpegish() {
  // Minimal JPEG SOF header with 64 x 36 dimensions (no full decoder involved).
  return Buffer.from([255,216,255,192,0,11,8,0,36,0,64,1,1,17,0,255,217]);
}

function officialThemeJson(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "official-glow",
    name: "Official Glow",
    image: "background.jpg",
    appearance: "dark",
    tagline: "From the Studio",
    quote: "STAY GLOWING",
    art: { focusX: 0.6, focusY: 0.4, safeArea: "left", taskMode: "ambient" },
    colors: {
      background: "#101014",
      panel: "rgba(16,16,20,0.7)",
      panelAlt: "rgba(24,24,30,0.8)",
      accent: "#7c3aed",
      accentAlt: "#a78bfa",
      secondary: "#22d3ee",
      highlight: "#f472b6",
      text: "#f5f3ff",
      muted: "#a5a3ae",
      line: "rgba(124,58,237,0.3)",
    },
    ...overrides,
  };
}

/**
 * Build a valid official package zip. Every payload is hashed into the manifest.
 */
function buildOfficialPackage({
  theme = officialThemeJson(),
  imageBytes = makeJpegish(),
  cssText = "sidebar { background-color: rgba(16, 16, 20, 0.5); }",
  includeCss = true,
  includeLicense = false,
  includeSig = false,
  manifestOverrides = {},
  themeOverrides = {},
} = {}) {
  const entries = new Map();
  const themeJson = officialThemeJson();
  const mergedTheme = { ...themeJson, ...themeOverrides };
  entries.set("theme.json", Buffer.from(JSON.stringify(mergedTheme)));
  entries.set(mergedTheme.image, imageBytes);
  if (includeCss) entries.set("theme.css", Buffer.from(cssText, "utf8"));
  if (includeLicense) entries.set("LICENSE.txt", Buffer.from("MIT\n"));
  if (includeSig) entries.set("manifest.sig", Buffer.from("ed25519:placeholder"));

  const media = (name) => {
    if (name === "theme.json") return "application/json";
    if (name === "theme.css") return "text/css";
    if (name === "LICENSE.txt") return "text/plain";
    if (name.endsWith(".png")) return "image/png";
    if (name.endsWith(".webp")) return "image/webp";
    return "image/jpeg";
  };
  const files = [...entries.entries()]
    .filter(([name]) => name !== "manifest.json" && name !== "manifest.sig")
    .map(([name, bytes]) => ({ path: name, mediaType: media(name), bytes: bytes.length, sha256: sha256(bytes) }));

  const manifest = {
    packageVersion: 1,
    themeId: mergedTheme.id,
    version: "1.2.3",
    skinApiVersion: 1,
    minClientVersion: "1.5.0",
    platforms: ["macos", "windows"],
    capabilities: includeCss ? ["background", "tokens", "safe-css"] : ["background", "tokens"],
    publisher: { id: "acme-studio", displayName: "Acme Studio" },
    license: "MIT",
    provenance: { aiGenerated: true, summary: "Test-built official package." },
    createdAt: "2026-09-30T12:00:00Z",
    files,
    ...manifestOverrides,
  };
  entries.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
  return buildZip(entries);
}

test("official package: happy path imports with provenance metadata", () => {
  const pkg = importThemePackage(buildOfficialPackage());
  assert.equal(pkg.meta.source, "dreamskin-official");
  assert.equal(pkg.theme.id, "official-glow");
  assert.equal(pkg.theme.name, "Official Glow");
  assert.equal(pkg.theme.appearance, "dark");
  assert.equal(pkg.image.name, "background.jpg");
  assert.equal(pkg.image.media, "image/jpeg");
  assert.ok(pkg.css.includes("sidebar"));
  assert.equal(pkg.meta.publisher.id, "acme-studio");
  assert.equal(pkg.meta.themeVersion, "1.2.3");
  assert.deepEqual(pkg.meta.platforms, ["macos", "windows"]);
  assert.ok(pkg.meta.capabilities.includes("safe-css"));
});

test("official package: official 10-key palette is preserved", () => {
  const pkg = importThemePackage(buildOfficialPackage());
  assert.equal(pkg.theme.colors.panelAlt, "rgba(24,24,30,0.8)");
  assert.equal(pkg.theme.colors.accentAlt, "#a78bfa");
  assert.equal(pkg.theme.colors.highlight, "#f472b6");
});

test("official package: schema mapping fills codexskin-only knobs", () => {
  const pkg = importThemePackage(buildOfficialPackage({
    themeOverrides: { art: undefined },
  }));
  assert.equal(pkg.theme.art.dim, 0.55);
  assert.equal(pkg.theme.art.taskDim, 0.75);
  assert.equal(pkg.theme.art.blur, 0);
  assert.equal(pkg.theme.art.focusX, 0.5);
});

test("official package: wrapper directory is stripped", () => {
  const files = readZip(buildOfficialPackage());
  const wrapped = new Map([...files.entries()].map(([k, v]) => [`OfficialGlow/${k}`, v]));
  const pkg = importThemePackage(buildZip(wrapped));
  assert.equal(pkg.meta.source, "dreamskin-official");
});

test("official package: tampered payload fails sha256 verification", () => {
  const files = readZip(buildOfficialPackage());
  const theme = JSON.parse(files.get("theme.json").toString("utf8"));
  // Same-length rename so the byte-length check passes and SHA-256 is what catches it.
  theme.name = theme.name.slice(0, -1) + (theme.name.endsWith("w") ? "x" : "w");
  files.set("theme.json", Buffer.from(JSON.stringify(theme)));
  assert.throws(() => importThemePackage(buildZip(files)), /SHA-256 does not match/);
});

test("official package: wrong declared byte length fails", () => {
  const files = readZip(buildOfficialPackage());
  const manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
  manifest.files.find((f) => f.path === "theme.json").bytes = 1;
  files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
  assert.throws(() => importThemePackage(buildZip(files)), /byte length does not match/);
});

test("official package: manifest metadata tampering is undetectable without signatures (documented limitation)", () => {
  // Payload hashes live IN the manifest, and the manifest is not signed in the
  // wild (manifest.sig is reserved-but-unverified). So metadata tampering that
  // leaves payload hashes consistent imports - and is recorded via
  // meta.manifestSha256 for a future pinning/signature layer.
  const files = readZip(buildOfficialPackage());
  const manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
  manifest.version = "9.9.9";
  files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
  const pkg = importThemePackage(buildZip(files));
  assert.equal(pkg.meta.themeVersion, "9.9.9");
  assert.equal(pkg.meta.manifestSigPresent, false);
  assert.equal(pkg.meta.signature, null);
  assert.match(pkg.meta.manifestSha256, /^[0-9a-f]{64}$/);
});

test("official package: themeId mismatch between manifest and theme.json fails", () => {
  const pkg0 = buildOfficialPackage();
  const files = readZip(pkg0);
  const manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
  // Rebuild the whole package with a manifest/themeId mismatch, rehashing theme.json
  // correctly so only the id cross-check fails.
  const theme = JSON.parse(files.get("theme.json").toString("utf8"));
  theme.id = "different-id";
  files.set("theme.json", Buffer.from(JSON.stringify(theme)));
  manifest.themeId = "different-id";
  const entry = manifest.files.find((f) => f.path === "theme.json");
  const bytes = files.get("theme.json");
  entry.bytes = bytes.length;
  entry.sha256 = sha256(bytes);
  files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
  // themeId now matches, so instead mismatch by changing manifest only:
  const manifest2 = JSON.parse(files.get("manifest.json").toString("utf8"));
  manifest2.themeId = "official-glow";
  files.set("manifest.json", Buffer.from(JSON.stringify(manifest2)));
  assert.throws(() => importThemePackage(buildZip(files)), /themeId does not match/);
});

test("official package: unregistered payload file fails", () => {
  const files = readZip(buildOfficialPackage());
  files.set("README.md", Buffer.from("hello"));
  assert.throws(() => importThemePackage(buildZip(files)), /unregistered file/);
});

test("official package: zip payload missing a declared file fails", () => {
  const files = readZip(buildOfficialPackage());
  files.delete("theme.css");
  assert.throws(() => importThemePackage(buildZip(files)), /do not exactly match/);
});

test("official package: theme.css without safe-css capability fails", () => {
  const pkg0 = buildOfficialPackage({ includeCss: true });
  const files = readZip(pkg0);
  const manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
  manifest.capabilities = ["background", "tokens"];
  files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
  assert.throws(() => importThemePackage(buildZip(files)), /safe-css capability/);
});

test("official package: missing theme.css fails outright", () => {
  assert.throws(
    () => importThemePackage(buildOfficialPackage({ includeCss: false })),
    /require theme.css/,
  );
});

test("official package: unsupported platform value fails", () => {
  assert.throws(
    () => importThemePackage(buildOfficialPackage({ manifestOverrides: { platforms: ["linux"] } })),
    /unsupported value|platforms/,
  );
});

test("official package: unsupported packageVersion fails", () => {
  assert.throws(
    () => importThemePackage(buildOfficialPackage({ manifestOverrides: { packageVersion: 2 } })),
    /packageVersion/,
  );
});

test("official package: bad provenance shape fails", () => {
  assert.throws(
    () => importThemePackage(buildOfficialPackage({ manifestOverrides: { provenance: { aiGenerated: "yes", summary: "x" } } })),
    /provenance.aiGenerated/,
  );
});

test("official package: manifest.sig present without trusted keys refuses import (fail closed)", () => {
  assert.throws(
    () => importThemePackage(buildOfficialPackage({ includeSig: true })),
    /no trusted keys are configured/,
  );
});

test("official package: LICENSE.txt is accepted and reported", () => {
  const pkg = importThemePackage(buildOfficialPackage({ includeLicense: true }));
  assert.equal(pkg.meta.licenseFileIncluded, true);
});

test("simple packages still import (no regression) and carry source metadata", () => {
  const pkg = importThemePackage(buildSampleThemeZip(SAMPLE_THEMES[0]));
  assert.equal(pkg.meta.source, "codexskin-simple");
  assert.equal(pkg.theme.id, "aurora-veil");
});
