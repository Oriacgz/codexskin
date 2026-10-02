import assert from "node:assert/strict";
import { test } from "node:test";
import { readZip } from "../src/core/zip.js";
import { importThemePackage, MAX_IMAGE_BYTES } from "../src/core/package.js";
import { validateSafeCss } from "../src/core/safe-css.js";
import { normalizeTheme } from "../src/core/theme.js";
import { SAMPLE_THEMES, buildSampleThemeZip, buildZip } from "../src/core/sample-themes.js";

test("zip round trip: build then read", () => {
  const zip = buildSampleThemeZip(SAMPLE_THEMES[0]);
  const files = readZip(zip);
  assert.ok(files.get("theme.json"));
  assert.ok(files.get("background.png"));
  assert.equal(files.size, SAMPLE_THEMES[0].css ? 3 : 2);
});

test("zip rejects path traversal entry names", () => {
  const entries = new Map([
    ["theme.json", Buffer.from("{}")],
    ["../evil.png", Buffer.from("x")],
  ]);
  assert.throws(() => readZip(buildZip(entries)), /path traversal/);
});

test("zip rejects backslash entry names", () => {
  const entries = new Map([["a\\b.png", Buffer.from("x")]]);
  assert.throws(() => readZip(buildZip(entries)), /unsafe entry name/);
});

test("zip rejects absolute entry names", () => {
  const entries = new Map([["/abs.png", Buffer.from("x")]]);
  assert.throws(() => readZip(buildZip(entries)), /absolute path/);
});

test("valid package imports cleanly", () => {
  const pkg = importThemePackage(buildSampleThemeZip(SAMPLE_THEMES[0]));
  assert.equal(pkg.theme.id, "aurora-veil");
  assert.equal(pkg.image.media, "image/png");
  assert.equal(pkg.image.name, "background.png");
  assert.ok(pkg.css.includes("--ds-theme-surface-opacity"));
});

test("package with wrapper directory imports cleanly", () => {
  const inner = buildSampleThemeZip(SAMPLE_THEMES[1]);
  const files = readZip(inner);
  const wrapped = new Map([...files.entries()].map(([k, v]) => [`MyTheme/${k}`, v]));
  const pkg = importThemePackage(buildZip(wrapped));
  assert.equal(pkg.theme.id, "paper-light");
});

test("package mixing root and directory entries fails", () => {
  const files = readZip(buildSampleThemeZip(SAMPLE_THEMES[0]));
  const wrapped = new Map([...files.entries()].map(([k, v]) => [`X/${k}`, v]));
  wrapped.set("stray.txt", Buffer.from("x"));
  assert.throws(() => importThemePackage(buildZip(wrapped)), /mixes root files/);
});

test("unregistered extra file fails closed", () => {
  const files = readZip(buildSampleThemeZip(SAMPLE_THEMES[0]));
  files.set("extra.js", Buffer.from("alert(1)"));
  assert.throws(() => importThemePackage(buildZip(files)), /unregistered file/);
});

test("image content must match extension", () => {
  const files = readZip(buildSampleThemeZip(SAMPLE_THEMES[0]));
  const themeJson = JSON.parse(files.get("theme.json").toString("utf8"));
  themeJson.image = "background.jpg";
  files.set("theme.json", Buffer.from(JSON.stringify(themeJson)));
  // rename entry to .jpg but keep PNG bytes -> media mismatch
  const pngBytes = files.get("background.png");
  files.delete("background.png");
  files.set("background.jpg", pngBytes);
  assert.throws(() => importThemePackage(buildZip(files)), /does not match/);
});

test("missing theme.json fails", () => {
  const files = readZip(buildSampleThemeZip(SAMPLE_THEMES[0]));
  files.delete("theme.json");
  assert.throws(() => importThemePackage(buildZip(files)), /missing theme.json/);
});

test("oversized image fails", () => {
  const big = Buffer.alloc(MAX_IMAGE_BYTES + 1, 1);
  // fake png magic so media check order is exercised
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), big.subarray(8)]);
  const entries = new Map([
    ["theme.json", Buffer.from(JSON.stringify({
      schemaVersion: 1, id: "big-image", name: "Big", image: "background.png",
    }))],
    ["background.png", png],
  ]);
  assert.throws(() => importThemePackage(buildZip(entries)), /exceeds/);
});

// --- safe-css ---

test("safe-css accepts and re-serializes valid subset", () => {
  const css = `/* comment */
sidebar:hover {
  background-color: rgba(16, 24, 32, 0.4);
  border-color: #34d399;
}
root { --ds-theme-surface-opacity: 0.8; }`;
  const out = validateSafeCss(css);
  assert.ok(!out.includes("/*"));
  assert.ok(out.includes("sidebar:hover"));
  assert.ok(out.includes("--ds-theme-surface-opacity: 0.8;"));
});

test("safe-css rejects url()", () => {
  assert.throws(() => validateSafeCss("main { background-color: url(https://evil) }"), /not allowed/);
});

test("safe-css rejects at-rules", () => {
  assert.throws(() => validateSafeCss("@import url(x); main { color: red }"), /unknown part/);
});

test("safe-css rejects unknown parts", () => {
  assert.throws(() => validateSafeCss("evil { color: red }"), /unknown part/);
});

test("safe-css rejects unknown properties", () => {
  assert.throws(() => validateSafeCss("main { position: fixed }"), /property not allowed/);
});

test("safe-css rejects custom properties outside root", () => {
  assert.throws(() => validateSafeCss("sidebar { --x: 1 }"), /only allowed in root/);
});

test("safe-css rejects non-ds custom properties", () => {
  assert.throws(() => validateSafeCss("root { --evil-thing: 1 }"), /custom property not allowed/);
});

test("safe-css rejects unterminated comments", () => {
  assert.throws(() => validateSafeCss("main { color: red } /* oops"), /unterminated comment/);
});

test("safe-css rejects braces smuggled into values", () => {
  assert.throws(() => validateSafeCss("main { color: #ff0000 } } body { display: none } x {"), /unknown part/);
});

// --- theme schema ---

test("theme schema fills defaults", () => {
  const t = normalizeTheme({ schemaVersion: 1, id: "test-theme", name: "T", image: "background.png" });
  assert.equal(t.art.focusX, 0.5);
  assert.equal(t.appearance, "auto");
  assert.equal(t.copy.quote, null);
});

test("theme schema rejects bad ids", () => {
  assert.throws(() => normalizeTheme({ schemaVersion: 1, id: "BAD ID!", name: "x", image: "background.png" }), /invalid id/);
});

test("theme schema rejects unknown image names", () => {
  assert.throws(() => normalizeTheme({ schemaVersion: 1, id: "x", name: "x", image: "art.png" }), /invalid image/);
});

test("theme schema rejects out-of-range focus", () => {
  assert.throws(
    () => normalizeTheme({ schemaVersion: 1, id: "x", name: "x", image: "background.png", art: { focusX: 2 } }),
    /between 0 and 1/,
  );
});
