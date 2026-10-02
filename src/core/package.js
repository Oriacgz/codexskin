// Theme package importer.
//
// A theme package is a plain .zip containing exactly:
//   theme.json           - schema (see theme.js)
//   theme.css            - optional non-empty safe-css subset (see safe-css.js)
//   background.(png|jpg|jpeg|webp) - the background image, <= 10 MiB
// Files may sit at the zip root or inside exactly one top-level directory
// (e.g. "MyTheme/"), which is how most zip tools wrap a folder.
//
// Everything is validated in memory before a single byte is written to disk;
// the caller receives a normalized theme + payloads and installs atomically.

import { readZip, ZIP_LIMITS } from "./zip.js";
import { normalizeTheme } from "./theme.js";
import { validateSafeCss } from "./safe-css.js";
import { detectImageMedia } from "./image.js";
import { importOfficialPackage } from "./dreamskin.js";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGE_EXT_TO_MEDIA = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
]);

function fail(message) {
  throw new Error(`theme package: ${message}`);
}

function decodeJson(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
  if (text.includes("\0")) fail(`${label} contains NUL bytes`);
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

/**
 * Validate an in-memory ZIP (.zip or .codextheme). Returns { theme, image: {name, media, bytes}, css, meta }.
 * Two formats are accepted, distinguished by the presence of manifest.json:
 *  - official DreamSkin.cc packages (see dreamskin.js)
 *  - codexskin simple packages (theme.json + image + optional theme.css)
 * `options` ({ trustedKeys, requireSignature }) applies to official packages.
 */
export function importThemePackage(zipBuffer, options = {}) {
  const files = readZip(zipBuffer);

  // Allow one wrapper directory: if every entry shares the same top-level
  // segment, strip it. More than one distinct root fails.
  const names = [...files.keys()];
  const roots = new Set(names.map((n) => (n.includes("/") ? n.split("/")[0] : "")));
  if (roots.size > 1) fail("archive mixes root files and a theme directory");
  let prefix = "";
  if (roots.size === 1 && names.every((n) => n.includes("/"))) {
    prefix = `${names[0].split("/")[0]}/`;
  }

  const rel = (name) => (name.startsWith(prefix) ? name.slice(prefix.length) : null);
  const byRel = new Map();
  for (const [name, bytes] of files) {
    const r = rel(name);
    if (r === null || r === "") fail(`unexpected entry in archive: ${name}`);
    byRel.set(r, bytes);
  }

  // Official DreamSkin.cc package path (manifest-declared, sha256-verified).
  if (byRel.has("manifest.json")) {
    return importOfficialPackage(byRel, options);
  }

  const themeBytes = byRel.get("theme.json");
  if (!themeBytes) fail("missing theme.json");
  if (themeBytes.length > 1024 * 1024) fail("theme.json too large");
  const theme = normalizeTheme(decodeJson(themeBytes, "theme.json"));

  const imageBytes = byRel.get(theme.image);
  if (!imageBytes) fail(`missing background image ${theme.image}`);
  if (imageBytes.length > MAX_IMAGE_BYTES) fail(`image exceeds ${MAX_IMAGE_BYTES} bytes`);
  const media = detectImageMedia(imageBytes);
  const ext = theme.image.split(".").pop().toLowerCase();
  if (!media) fail(`${theme.image} is not a PNG/JPEG/WebP image (magic bytes)`);
  if (media !== IMAGE_EXT_TO_MEDIA.get(ext)) fail(`${theme.image} content does not match its extension`);
  // Normalize the stored name so downstream code only ever sees one of three names.
  const canonicalImage = media === "image/jpeg" ? "background.jpg" : `background.${ext === "jpeg" ? "jpg" : ext}`;

  let css = null;
  const cssBytes = byRel.get("theme.css");
  if (cssBytes) css = validateSafeCss(cssBytes.toString("utf8"));

  // No unregistered extras - fail closed rather than silently ignoring files.
  for (const key of byRel.keys()) {
    if (key !== "theme.json" && key !== theme.image && key !== "theme.css") {
      fail(`unregistered file in package: ${key}`);
    }
  }

  return {
    theme,
    image: { name: canonicalImage, media, bytes: imageBytes },
    css,
    meta: { source: "codexskin-simple" },
    limits: ZIP_LIMITS,
  };
}
