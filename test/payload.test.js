import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildApplyExpression,
  buildRestoreExpression,
  buildVerifyExpression,
} from "../src/core/payload.js";

const theme = {
  schemaVersion: 1,
  id: "aurora-veil",
  name: "Aurora Veil",
  image: "background.png",
  appearance: "auto",
  art: { focusX: 0.7, focusY: 0.35, safeArea: "right", taskMode: "ambient", dim: 0.45, taskDim: 0.7, blur: 0 },
  colors: { accent: "#34d399" },
  dataUrl: "data:image/png;base64,iVBORw0KGgo=",
};

test("apply expression embeds theme and css as string literals", () => {
  const expr = buildApplyExpression(theme, "root { --ds-theme-surface-opacity: 0.5; }");
  assert.ok(expr.includes('"aurora-veil"'));
  assert.ok(expr.includes("--ds-theme-surface-opacity"));
  assert.ok(expr.includes("data:image/png;base64,iVBORw0KGgo="));
});

test("apply expression survives quotes and newlines in css", () => {
  const css = 'root { --ds-theme-quote: "it\'s fine"; }';
  const expr = buildApplyExpression(theme, css);
  assert.ok(expr.length > 0);
  // Should be parseable JS: cheap check via Function constructor
  new Function(expr);
});

test("apply expression survives backslashes and template syntax in css", () => {
  const css = "root { --ds-theme-note: a\\\\b${window.alert()} }";
  const expr = buildApplyExpression(theme, css);
  new Function(expr);
});

test("verify expression references theme id literally", () => {
  const expr = buildVerifyExpression("aurora-veil");
  assert.ok(expr.includes('"aurora-veil"'));
  new Function(expr);
});

test("restore expression is standalone", () => {
  const expr = buildRestoreExpression();
  new Function(expr);
});
