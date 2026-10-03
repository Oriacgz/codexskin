import { validateSettings } from './customization.js';
// codexskin theme schema (v1) - validated, fail-closed, always-normalized output.
// Mirrors the DreamSkin simple package contract so existing .zip themes import.

const CONTROL = /[\u0000-\u001f\u007f]/u;
const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const IMAGE_PATTERN = /^background\.(?:png|jpe?g|webp)$/i;
const COLOR_PATTERN = /^(?:#[0-9a-fA-F]{3,8}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:0|1|0?\.\d{1,4})\s*\))$/;

const COPY_KEYS = ["tagline", "quote", "statusText", "brandSubtitle", "projectPrefix", "projectLabel", "promoTitle", "promoSub"];
// Superset palette: codexskin's 6 core keys + DreamSkin's official 10-key set
// (panelAlt, accentAlt, secondary, highlight are used by DreamSkin Studio css).
const COLOR_KEYS = [
  "background", "panel", "accent", "text", "muted", "line",
  "panelAlt", "accentAlt", "secondary", "highlight",
];

export function fail(message) {
  throw new Error(`theme.json: ${message}`);
}

function str(value, label, { max, pattern, fallback } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || CONTROL.test(value) || value.length > (max ?? 200)) {
    fail(`invalid ${label}`);
  }
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (pattern && !pattern.test(trimmed)) fail(`invalid ${label}`);
  return trimmed;
}

function num(value, label, fallback, min, max) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    fail(`${label} must be between ${min} and ${max}`);
  }
  return value;
}

function color(value, label, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !COLOR_PATTERN.test(value.trim())) fail(`invalid ${label} color`);
  return value.trim();
}

/**
 * Validate + normalize a parsed theme.json object. Throws on anything unsafe;
 * returns a fully-defaulted theme so downstream code never branches on missing fields.
 */
export function normalizeTheme(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail("must be a JSON object");
  const t = input;

  if (t.schemaVersion !== 1) fail("schemaVersion must be 1");
  const id = str(t.id, "id", { max: 64, pattern: ID_PATTERN }) ?? fail("missing id");
  const name = str(t.name, "name", { max: 80 }) ?? "Untitled theme";

  // image: exactly "background.png|jpg|jpeg|webp" - a bare filename beside theme.json
  const image = str(t.image, "image", { max: 32, pattern: IMAGE_PATTERN }) ?? fail("missing image");

  const appearance = ["auto", "light", "dark"].includes(t.appearance) ? t.appearance : "auto";
  const art = t.art ?? {};
  const safeArea = ["left", "right", "none"].includes(art.safeArea) ? art.safeArea : "none";
  const taskMode = ["ambient", "full", "off"].includes(art.taskMode) ? art.taskMode : "ambient";

  const colors = {};
  for (const key of COLOR_KEYS) colors[key] = color(t.colors?.[key], `colors.${key}`, null);

  return {
    ...(t.settings ? { settings: validateSettings(t.settings) } : {}),
    schemaVersion: 1,
    id,
    name,
    image,
    appearance,
    art: {
      focusX: num(art.focusX, "art.focusX", 0.5, 0, 1),
      focusY: num(art.focusY, "art.focusY", 0.5, 0, 1),
      safeArea,
      taskMode,
      dim: num(art.dim, "art.dim", 0.55, 0, 0.95),
      taskDim: num(art.taskDim, "art.taskDim", 0.75, 0, 0.95),
      blur: num(art.blur, "art.blur", 0, 0, 40),
    },
    colors,
    copy: Object.fromEntries(COPY_KEYS.map((k) => [k, str(t[k] ?? t.copy?.[k], k, { max: 160 }) ?? null])),
  };
}
