import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSafeCss } from "../src/core/safe-css.js";
import { buildApplyExpression } from "../src/core/payload.js";

test("official dialect: [data-ds-part] selectors normalize to bare parts", () => {
  // Re-serialization canonicalizes the attribute form to the bare part name;
  // the payload rewriter accepts both spellings on input.
  const out = validateSafeCss('[data-ds-part="root"] { color: #ffffff; }');
  assert.ok(out.startsWith("root {"));
  assert.ok(!out.includes("data-ds-part"));
});

test("official dialect: attribute selector with :hover state", () => {
  const out = validateSafeCss('[data-ds-part="composer"]:hover { background-color: rgba(0,0,0,0.5); }');
  assert.ok(out.startsWith("composer:hover {"));
});

test("official dialect: unknown part in attribute form still rejected", () => {
  assert.throws(
    () => validateSafeCss('[data-ds-part="evil"] { color: red; }'.replace("red", "#ff0000")),
    /unknown part/,
  );
});

test("official dialect: var() references accepted for any property", () => {
  const out = validateSafeCss([
    '[data-ds-part="sidebar"] { background-color: var(--ds-theme-color-panel); }',
    "root { --ds-theme-surface-opacity: var(--ds-theme-surface-blur); }",
  ].join("\n"));
  assert.ok(out.includes("var(--ds-theme-color-panel)"));
});

test("official dialect: var() with a safe fallback accepted", () => {
  const out = validateSafeCss('sidebar { color: var(--ds-theme-color-text, #ffffff); }');
  assert.ok(out.includes("var(--ds-theme-color-text, #ffffff)"));
});

test("official dialect: url() disguised via var fallback rejected", () => {
  assert.throws(
    () => validateSafeCss("sidebar { color: var(--ds-theme-color-text, url(https://evil)); }"),
    /value not allowed|not allowed/,
  );
});

test("official dialect: non-theme custom property in var() rejected", () => {
  assert.throws(
    () => validateSafeCss("sidebar { color: var(--evil); }"),
    /value not allowed/,
  );
});

test("official dialect: mixed dialects and per-side borders round trip", () => {
  const css = [
    '[data-ds-part="root"] {',
    "  background-color: var(--ds-theme-color-background);",
    "  color: var(--ds-theme-color-text);",
    "}",
    '[data-ds-part="home-hero"] {',
    "  background-color: transparent;",
    "  border-top-width: 0;",
    "  border-top-style: none;",
    "}",
  ].join("\n");
  const out = validateSafeCss(css);
  assert.ok(out.includes("border-top-style: none;"));
});

test("payload: official variables are defined and parts rewritten", () => {
  const theme = {
    schemaVersion: 1,
    id: "official-glow",
    name: "Official Glow",
    image: "background.png",
    appearance: "dark",
    art: { focusX: 0.5, focusY: 0.5, safeArea: "none", taskMode: "ambient", dim: 0.55, taskDim: 0.75, blur: 0 },
    colors: {
      background: "#101014",
      panel: "#0f2a23",
      accent: "#5fc6a5",
      text: "#f5f3ff",
      muted: "#a5a3ae",
      line: "rgba(124,58,237,0.3)",
    },
    copy: {},
    dataUrl: "data:image/png;base64,x",
  };
  const themeCss = validateSafeCss([
    '[data-ds-part="root"] { background-color: var(--ds-theme-color-background); }',
    '[data-ds-part="thread"] { border-bottom-color: var(--ds-theme-color-line); }',
  ].join("\n"));
  const expr = buildApplyExpression(theme, themeCss);
  // Extract STYLE_CSS from the expression and check the rendered stylesheet.
  const start = expr.indexOf("const STYLE_CSS = ") + "const STYLE_CSS = ".length;
  const end = expr.indexOf(";\n  const LAYER_ID");
  const styleCss = JSON.parse(expr.slice(start, end));
  assert.ok(styleCss.includes("--ds-theme-color-accent: #5fc6a5"));
  assert.ok(styleCss.includes('html[data-codexskin="active"] { background-color: var(--ds-theme-color-background); }'));
  assert.ok(!styleCss.includes('html[data-codexskin="active"] html {'));
  assert.ok(styleCss.includes(".thread-scroll-container"));
  assert.ok(!styleCss.includes("[data-ds-part=")); // symbolic form fully translated
});
