// Safe-CSS subset validator (contract: codexskin-safe-css/1).
//
// Design principle: we do not sanitize CSS in place - we parse a strict subset
// and re-serialize ONLY validated tokens. Output can never contain anything the
// parser did not explicitly allow, so injection via comments, escapes, url(),
// @import, nested at-rules, etc. is structurally impossible, not pattern-blocked.

const MAX_BYTES = 262_144;
const MAX_RULES = 96;
const MAX_DECLS = 512;
const MAX_VALUE_CHARS = 512;

// Parts = registered UI regions the injector exposes as CSS variables.
export const PARTS = Object.freeze([
  "root", "sidebar", "main", "header", "home", "home-hero",
  "project-list", "thread", "message", "composer", "composer-toolbar", "dialog",
]);
const PART_SET = new Set(PARTS);

const STATE_SET = new Set(["hover", "focus-visible"]);

export const PROPERTIES = Object.freeze([
  "background-color", "color", "opacity",
  "border-color", "border-radius", "border-width",
  "border-top-color", "border-top-width", "border-top-style",
  "border-right-color", "border-right-width", "border-right-style",
  "border-bottom-color", "border-bottom-width", "border-bottom-style",
  "border-left-color", "border-left-width", "border-left-style",
  "border-top-left-radius", "border-top-right-radius",
  "border-bottom-left-radius", "border-bottom-right-radius",
  "box-shadow", "backdrop-filter",
  "font-family", "font-size", "font-weight", "letter-spacing", "line-height",
  "gap", "row-gap", "column-gap",
  "transition-property", "transition-duration",
]);

const PROP_SET = new Set(PROPERTIES);

const LENGTH = /^(?:0|[1-9]\d*|0?\.\d+)(?:px|em|rem|%)?$/;
const DURATION = /^(?:0|[1-9]\d*|0?\.\d+)(?:ms|s)$/;
const RADIUS = LENGTH;
const OPACITY = /^(?:0|1|0?\.\d{1,4})$/;
const FONT_WEIGHT = /^(?:100|[1-9]00|bold|normal)$/;
const FONT_FAMILY = /^[A-Za-z][A-Za-z0-9 _-]*(?:,[A-Za-z][A-Za-z0-9 _-]*)*$/; // bare names only, no quotes
const TRANSITION_PROPERTY = /^[a-z-]+(?:\s*,\s*[a-z-]+)*$/;

const COLOR = /^(?:#[0-9a-fA-F]{3,8}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:0|1|0?\.\d{1,4})\s*\)|transparent|inherit)$/;

// var() references to theme variables - the official Studio dialect. A var
// reference cannot execute anything; it only reads variables the injector
// defines, so any --ds-theme-* variable is acceptable. An optional fallback
// must itself be a safe color or length.
const VAR_REFERENCE = /^var\(\s*--ds-theme-[a-z0-9-]+(?:\s*,\s*(?:#[0-9a-fA-F]{3,8}|transparent|inherit|(?:0|[1-9]\d*|0?\.\d+)(?:px|em|rem|%)?|\d+(?:\.\d+)?)\s*)?\)$/i;

const VALUE_PATTERNS = new Map([
  ["background-color", [COLOR]],
  ["color", [COLOR]],
  ["opacity", [OPACITY]],
  ["border-color", [COLOR]],
  ["border-radius", [RADIUS]],
  ["border-width", [LENGTH]],
  ["border-top-color", [COLOR]],
  ["border-top-width", [LENGTH]],
  ["border-top-style", [/^(?:solid|dashed|dotted|none|hidden|double)$/]],
  ["border-right-color", [COLOR]],
  ["border-right-width", [LENGTH]],
  ["border-right-style", [/^(?:solid|dashed|dotted|none|hidden|double)$/]],
  ["border-bottom-color", [COLOR]],
  ["border-bottom-width", [LENGTH]],
  ["border-bottom-style", [/^(?:solid|dashed|dotted|none|hidden|double)$/]],
  ["border-left-color", [COLOR]],
  ["border-left-width", [LENGTH]],
  ["border-left-style", [/^(?:solid|dashed|dotted|none|hidden|double)$/]],
  ["border-top-left-radius", [RADIUS]],
  ["border-top-right-radius", [RADIUS]],
  ["border-bottom-left-radius", [RADIUS]],
  ["border-bottom-right-radius", [RADIUS]],
  ["box-shadow", [/^none$|^[-0-9a-z# ().,%]+$/i]],
  ["backdrop-filter", [/^none$|^blur\(\s*\d+(?:\.\d+)?px\s*\)$/]],
  ["font-family", [FONT_FAMILY]],
  ["font-size", [LENGTH]],
  ["font-weight", [FONT_WEIGHT]],
  ["letter-spacing", [LENGTH]],
  ["line-height", [LENGTH, /^\d+(?:\.\d+)?$/]],
  ["gap", [LENGTH]],
  ["row-gap", [LENGTH]],
  ["column-gap", [LENGTH]],
  ["transition-property", [TRANSITION_PROPERTY, /^all$/, /^none$/]],
  ["transition-duration", [DURATION]],
]);

function fail(message) {
  throw new Error(`safe-css: ${message}`);
}

function validateDeclaration(prop, rawValue) {
  if (!PROP_SET.has(prop)) fail(`property not allowed: ${prop}`);
  const value = rawValue.trim().replace(/\s+/g, " ");
  if (!value) fail(`empty value for ${prop}`);
  if (value.length > MAX_VALUE_CHARS) fail(`value too long for ${prop}`);
  if (/[;{}\\]/.test(value)) fail(`unsafe character in value for ${prop}`);
  // var() references are universally safe - accepted for every property.
  if (VAR_REFERENCE.test(value)) return `${prop}: ${value};`;
  const patterns = VALUE_PATTERNS.get(prop);
  if (!patterns || !patterns.some((p) => p.test(value))) fail(`value not allowed for ${prop}: ${value}`);
  return `${prop}: ${value};`;
}

function stripComments(css) {
  // Comments are removed BEFORE tokenization; any unterminated comment fails.
  let out = "";
  for (let i = 0; i < css.length; i += 1) {
    if (css[i] === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end === -1) fail("unterminated comment");
      i = end + 1;
      out += " ";
      continue;
    }
    out += css[i];
  }
  return out;
}

/**
 * Validate theme.css and return a re-serialized, guaranteed-safe stylesheet.
 * Accepts only:
 *   <part>[:hover|:focus-visible] { <prop>: <value>; ... }
 *   --ds-* custom property declarations inside `root`
 * Nothing else (no selectors, no at-rules, no nesting, no strings).
 */
export function validateSafeCss(cssText) {
  if (typeof cssText !== "string") fail("css must be a string");
  const bytes = Buffer.byteLength(cssText, "utf8");
  if (bytes < 1) fail("css is empty");
  if (bytes > MAX_BYTES) fail(`css exceeds ${MAX_BYTES} bytes`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(cssText)) fail("css contains control characters");

  const css = stripComments(cssText);
  const output = [];
  let ruleCount = 0;
  let declCount = 0;
  let i = 0;

  while (i < css.length) {
    while (i < css.length && /\s/.test(css[i])) i += 1;
    if (i >= css.length) break;

    // selector token up to '{'
    const open = css.indexOf("{", i);
    if (open === -1) fail("expected '{'");
    const selector = css.slice(i, open).trim().replace(/\s+/g, " ");
    if (!selector) fail("empty selector");

    const close = css.indexOf("}", open);
    if (close === -1) fail("unterminated rule");

    ruleCount += 1;
    if (ruleCount > MAX_RULES) fail(`more than ${MAX_RULES} rules`);

    // Parse selector: part + optional single state, in either dialect:
    //   root, sidebar:hover            (codexskin shorthand)
    //   [data-ds-part="root"],         (official Studio attribute form)
    //   [data-ds-part="composer"]:hover
    let part = selector;
    let state = null;
    const attrMatch = /^\[data-ds-part="([a-z-]+)"\](?::(hover|focus-visible))?$/.exec(selector);
    const bareMatch = /^([^:]+)(?::(hover|focus-visible))?$/.exec(selector);
    if (attrMatch) {
      part = attrMatch[1];
      state = attrMatch[2] ?? null;
    } else if (bareMatch) {
      part = bareMatch[1].trim();
      state = bareMatch[2] ?? null;
    }
    if (!PART_SET.has(part)) fail(`unknown part in selector: ${selector}`);
    if (state && !STATE_SET.has(state)) fail(`unknown state in selector: ${selector}`);

    const body = css.slice(open + 1, close);
    const decls = [];
    for (const rawDecl of body.split(";")) {
      const decl = rawDecl.trim();
      if (!decl) continue;
      declCount += 1;
      if (declCount > MAX_DECLS) fail(`more than ${MAX_DECLS} declarations`);
      const colon = decl.indexOf(":");
      if (colon === -1) fail(`malformed declaration: ${decl.slice(0, 60)}`);
      const prop = decl.slice(0, colon).trim();
      const value = decl.slice(colon + 1);

      if (prop.startsWith("--")) {
        if (part !== "root") fail(`custom property ${prop} only allowed in root`);
        if (!/^--ds-[a-z0-9-]+$/.test(prop)) fail(`custom property not allowed: ${prop}`);
        const v = value.trim().replace(/\s+/g, " ");
        if (!v || v.length > MAX_VALUE_CHARS || /[;{}\\@"']/.test(v)
          || /(?:url|image|image-set|expression)\s*\(/i.test(v)
          || !/^[a-z0-9# (),.%_+\/-]+$/i.test(v)) fail(`unsafe value for ${prop}`);
        decls.push(`${prop}: ${v};`);
      } else {
        decls.push(validateDeclaration(prop, value));
      }
    }

    if (decls.length > 0) {
      const sel = state ? `${part}:${state}` : part;
      output.push(`${sel} {\n  ${decls.join("\n  ")}\n}`);
    }
    i = close + 1;
  }

  return output.join("\n\n") + (output.length ? "\n" : "");
}
