// Official DreamSkin.cc package support (manifest contract "packageVersion 1").
//
// An official package is a zip with manifest.json + payload files, where the
// manifest declares every payload file's mediaType, byte length, and SHA-256.
// We validate that contract strictly, then MAP the official theme.json onto the
// codexskin schema - the stored theme is pure codexskin; the manifest data is
// kept as provenance metadata.
//
// Signature verification is opt-in through trusted keys and requireSignature.
// Compatibility-profile fetching is not performed. Imports stay local-only.

import { createHash } from "node:crypto";
import { detectImageMedia,inspectImage } from "./image.js";
import { validateSafeCss } from "./safe-css.js";
import { normalizeTheme } from "./theme.js";
import {
  parseSignatureEnvelope,
  verifyEnvelopeBytes,
} from "./trust.js";

const LIMITS = Object.freeze({
  manifest: 65_536,
  theme: 65_536,
  css: 262_144,
  image: 10 * 1024 * 1024,
  license: 65_536,
  signature: 4_096,
});

// Official media types per payload file. Exactly one background is required.
const BACKGROUND_MEDIA = new Map([
  ["background.webp", "image/webp"],
  ["background.jpg", "image/jpeg"],
  ["background.png", "image/png"],
]);
const PAYLOAD_MEDIA = new Map([
  ["theme.json", "application/json"],
  ...BACKGROUND_MEDIA,
  ["theme.css", "text/css"],
  ["LICENSE.txt", "text/plain"],
]);

const MANIFEST_REQUIRED = [
  "packageVersion", "themeId", "version", "skinApiVersion", "minClientVersion",
  "platforms", "capabilities", "publisher", "license", "provenance", "files", "createdAt",
];
const THEME_REQUIRED = ["schemaVersion", "id", "name", "image"];
const THEME_COPY_KEYS = [
  "brandSubtitle", "tagline", "projectPrefix", "projectLabel",
  "statusText", "quote", "promoTitle", "promoSub",
];
const COLOR_KEYS = [
  "background", "panel", "panelAlt", "accent", "accentAlt", "secondary",
  "highlight", "text", "muted", "line",
];
const COLOR_PATTERN = /^(#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?|#[0-9a-fA-F]{3,4}|rgb\(\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*\)|rgba\(\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*,\s*(?:0|1|1\.0|0?\.[0-9]{1,6})\s*\))$/;
const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const THEME_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const PUBLISHER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const RFC3339_PATTERN = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;

function fail(message) {
  throw new Error(`dreamskin package: ${message}`);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, required, optional, label) {
  if (!isObject(value)) fail(`${label} must be an object`);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${label} is missing ${key}`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} contains unsupported field ${key}`);
  }
}

function assertString(value, label, { min = 0, max, pattern } = {}) {
  if (typeof value !== "string") fail(`${label} must be a string`);
  if (value.length < min || (max !== undefined && value.length > max)) {
    fail(`${label} has an invalid length`);
  }
  if (CONTROL_PATTERN.test(value)) fail(`${label} contains control characters`);
  if (pattern && !pattern.test(value)) fail(`${label} has an invalid format`);
  return value;
}

function assertStringSet(value, label, { min, max, allowed }) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail(`${label} must contain between ${min} and ${max} values`);
  }
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item)) fail(`${label} contains an unsupported value`);
    if (seen.has(item)) fail(`${label} repeats ${item}`);
    seen.add(item);
  }
  return seen;
}

function decodeJson(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
  if (text.includes("\0")) fail(`${label} contains NUL characters`);
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateOfficialTheme(value) {
  assertExactKeys(
    value,
    THEME_REQUIRED,
    [...THEME_COPY_KEYS, "promoUrl", "appearance", "art", "colors"],
    "theme.json",
  );
  if (value.schemaVersion !== 1) fail("theme.json must use schemaVersion 1");
  assertString(value.id, "theme.json.id", { min: 3, max: 64, pattern: THEME_ID_PATTERN });
  assertString(value.name, "theme.json.name", { min: 1, max: 80 });
  assertString(value.image, "theme.json.image", { min: 1, max: 32 });
  if (!BACKGROUND_MEDIA.has(value.image)) {
    fail("theme.json.image must name one registered background file");
  }
  for (const key of THEME_COPY_KEYS) {
    if (value[key] !== undefined) assertString(value[key], `theme.json.${key}`, { max: 120 });
  }
  if (value.promoUrl !== undefined) assertString(value.promoUrl, "theme.json.promoUrl", { max: 512 });
  if (value.appearance !== undefined && !["auto", "light", "dark"].includes(value.appearance)) {
    fail("theme.json.appearance is unsupported");
  }
  if (value.art !== undefined) {
    assertExactKeys(value.art, [], ["focusX", "focusY", "safeArea", "taskMode"], "theme.json.art");
    for (const key of ["focusX", "focusY"]) {
      const v = value.art[key];
      if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1)) {
        fail(`theme.json.art.${key} must be between 0 and 1`);
      }
    }
    if (value.art.safeArea !== undefined && !["left", "right", "none"].includes(value.art.safeArea)) {
      fail("theme.json.art.safeArea is unsupported");
    }
    if (value.art.taskMode !== undefined && !["ambient", "full", "off"].includes(value.art.taskMode)) {
      fail("theme.json.art.taskMode is unsupported");
    }
  }
  if (value.colors !== undefined) {
    assertExactKeys(value.colors, [], COLOR_KEYS, "theme.json.colors");
    for (const key of COLOR_KEYS) {
      const v = value.colors[key];
      if (v === undefined) continue;
      assertString(v, `theme.json.colors.${key}`, { min: 1, max: 64, pattern: COLOR_PATTERN });
    }
  }
  return value;
}

function validateManifest(value) {
  assertExactKeys(value, MANIFEST_REQUIRED, ["keyId"], "manifest.json");
  if (value.packageVersion !== 1) fail("manifest.json must use packageVersion 1");
  if (value.skinApiVersion !== 1) fail("manifest.json requires an unsupported Skin API version");
  assertString(value.themeId, "manifest.themeId", { min: 3, max: 64, pattern: THEME_ID_PATTERN });
  assertString(value.version, "manifest.version", { min: 5, max: 32, pattern: SEMVER_PATTERN });
  // Format-only: codexskin's payload contract is version 1, so any declared
  // minimum that parses is acceptable; we record it as metadata.
  assertString(value.minClientVersion, "manifest.minClientVersion", { min: 5, max: 32, pattern: SEMVER_PATTERN });
  assertStringSet(value.platforms, "manifest.platforms", {
    min: 1, max: 2, allowed: new Set(["macos", "windows"]),
  });
  assertStringSet(value.capabilities, "manifest.capabilities", {
    min: 1, max: 3, allowed: new Set(["background", "tokens", "safe-css"]),
  });

  assertExactKeys(value.publisher, ["id", "displayName"], [], "manifest.publisher");
  assertString(value.publisher.id, "manifest.publisher.id", {
    min: 1, max: 64, pattern: PUBLISHER_ID_PATTERN,
  });
  assertString(value.publisher.displayName, "manifest.publisher.displayName", { min: 1, max: 80 });
  assertString(value.license, "manifest.license", { min: 1, max: 64 });

  assertExactKeys(value.provenance, ["aiGenerated", "summary"], [], "manifest.provenance");
  if (typeof value.provenance.aiGenerated !== "boolean") {
    fail("manifest.provenance.aiGenerated must be boolean");
  }
  assertString(value.provenance.summary, "manifest.provenance.summary", { min: 1, max: 500 });

  if (value.keyId !== undefined) {
    assertString(value.keyId, "manifest.keyId", { min: 1, max: 64 });
  }
  assertString(value.createdAt, "manifest.createdAt", { min: 20, max: 40, pattern: RFC3339_PATTERN });

  if (!Array.isArray(value.files) || value.files.length < 2 || value.files.length > 8) {
    fail("manifest.files must contain between 2 and 8 entries");
  }
  const files = new Map();
  for (let i = 0; i < value.files.length; i += 1) {
    const entry = value.files[i];
    assertExactKeys(entry, ["path", "mediaType", "bytes", "sha256"], [], `manifest.files[${i}]`);
    if (typeof entry.path !== "string" || !PAYLOAD_MEDIA.has(entry.path)) {
      fail(`manifest.files[${i}].path is unsupported`);
    }
    if (files.has(entry.path)) fail(`manifest.files repeats ${entry.path}`);
    if (entry.mediaType !== PAYLOAD_MEDIA.get(entry.path)) {
      fail(`manifest.files mediaType does not match ${entry.path}`);
    }
    const limit = entry.path === "manifest.json" ? LIMITS.manifest
      : entry.path === "theme.json" ? LIMITS.theme
      : entry.path === "theme.css" ? LIMITS.css
      : entry.path === "LICENSE.txt" ? LIMITS.license
      : LIMITS.image;
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > limit) {
      fail(`manifest.files bytes for ${entry.path} exceed the limit`);
    }
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      fail(`manifest.files SHA-256 for ${entry.path} is invalid`);
    }
    files.set(entry.path, entry);
  }
  const backgrounds = [...files.keys()].filter((name) => BACKGROUND_MEDIA.has(name));
  if (!files.has("theme.json") || backgrounds.length !== 1) {
    fail("manifest.files must contain theme.json and exactly one background file");
  }
  // Official imports require theme.css + the matching capability declaration.
  if (files.has("theme.css") !== value.capabilities.includes("safe-css")) {
    fail("theme.css presence must match the safe-css capability");
  }
  if (!files.has("theme.css")) {
    fail("official theme imports require theme.css and the safe-css capability");
  }
  return { manifest: value, files, background: backgrounds[0] };
}

/**
 * Map a validated official theme.json onto the codexskin schema.
 */
export function mapOfficialTheme(official) {
  const mapped = {
    schemaVersion: 1,
    id: official.id,
    name: official.name,
    image: official.image,
    appearance: official.appearance ?? "auto",
    art: {
      focusX: official.art?.focusX ?? 0.5,
      focusY: official.art?.focusY ?? 0.5,
      safeArea: official.art?.safeArea ?? "none",
      taskMode: official.art?.taskMode ?? "ambient",
      // Official format does not carry codexskin dim/blur knobs; safe defaults.
      dim: 0.55,
      taskDim: 0.75,
      blur: 0,
    },
  };
  const copy = {};
  for (const key of THEME_COPY_KEYS) {
    if (official[key] !== undefined) copy[key] = official[key];
  }
  if (Object.keys(copy).length > 0) mapped.copy = copy;
  if (official.colors !== undefined) mapped.colors = official.colors;
  return mapped;
}

/**
 * Validate an extracted official package (already prefix-stripped by the zip
 * layer). `files` maps exact names to Buffers.
 *
 * Signature handling (fail closed):
 *  - manifest.sig present + trustedKeys provided  -> verify; mismatch refuses import
 *  - manifest.sig present + no trustedKeys        -> refuses import (unverifiable)
 *  - no manifest.sig + requireSignature           -> refuses import
 *  - no manifest.sig, not required                -> imports with meta.signature = null
 *
 * Returns the same shape as importThemePackage's simple path, plus metadata.
 */
export function importOfficialPackage(files, options = {}) {
  const { trustedKeys = null, requireSignature = false } = options;
  for (const name of files.keys()) {
    if (name !== "manifest.json" && name !== "manifest.sig" && !PAYLOAD_MEDIA.has(name)) {
      fail(`official theme package contains unregistered file ${name}`);
    }
  }
  if (!files.has("manifest.json")) fail("missing manifest.json");
  const manifestBytes = files.get("manifest.json");
  if (manifestBytes.length < 1 || manifestBytes.length > LIMITS.manifest) {
    fail("manifest.json size out of bounds");
  }
  const { manifest, files: declared, background } = validateManifest(decodeJson(manifestBytes, "manifest.json"));

  const payloadNames = [...files.keys()].filter((n) => n !== "manifest.json" && n !== "manifest.sig");
  const declaredNames = new Set(declared.keys());
  if (payloadNames.length !== declaredNames.size
    || !payloadNames.every((n) => declaredNames.has(n))) {
    fail("zip payload files do not exactly match manifest.files");
  }

  // Verify every declared file: byte length, then SHA-256 (tamper evidence).
  for (const [name, entry] of declared) {
    const bytes = files.get(name);
    if (!bytes) fail(`manifest.files declares missing file ${name}`);
    if (bytes.length !== entry.bytes) fail(`${name} byte length does not match manifest.json`);
    if (sha256(bytes) !== entry.sha256) fail(`${name} SHA-256 does not match manifest.json`);
  }

  const officialTheme = validateOfficialTheme(decodeJson(files.get("theme.json"), "theme.json"));
  if (manifest.themeId !== officialTheme.id) {
    fail("manifest.themeId does not match theme.json id");
  }
  if (officialTheme.image !== background) {
    fail("theme.json image does not match the manifest background file");
  }

  const imageBytes = files.get(background);
  const media = detectImageMedia(imageBytes);
  if (media !== BACKGROUND_MEDIA.get(background)) {
    fail(`${background} content does not match its extension and mediaType`);
  }
  // Canonicalize to codexskin's image naming (jpeg -> jpg).
  const canonicalImage = media === "image/jpeg" ? "background.jpg" : background;
  inspectImage(imageBytes);

  const css = validateSafeCss(files.get("theme.css").toString("utf8"));

  // --- signature verification (see doc comment above) ---
  const sigBytes = files.get("manifest.sig") ?? null;
  let signature = null;
  if (sigBytes) {
    if (!trustedKeys) {
      fail(
        "package carries manifest.sig but no trusted keys are configured; "
        + "import with --trusted-keys <file> to verify it",
      );
    }
    const envelope = parseSignatureEnvelope(sigBytes);
    const trustedKey = trustedKeys.get(envelope.keyId);
    if (!trustedKey) {
      fail(`package is signed by keyId "${envelope.keyId}" which is not in the trusted-keys file`);
    }
    verifyEnvelopeBytes(envelope, manifestBytes, trustedKey);
    signature = { verified: true, keyId: envelope.keyId, algorithm: "ed25519" };
  } else if (requireSignature) {
    fail("signatures are required but the package has no manifest.sig");
  }

  const theme = normalizeTheme(mapOfficialTheme(officialTheme));
  // Keep the official id even if codexskin's canonicalization changed nothing.
  theme.id = officialTheme.id;
  theme.image = canonicalImage;

  return {
    theme,
    image: { name: canonicalImage, media, bytes: imageBytes },
    css,
    meta: {
      source: "dreamskin-official",
      themeVersion: manifest.version,
      minClientVersion: manifest.minClientVersion,
      skinApiVersion: manifest.skinApiVersion,
      platforms: manifest.platforms,
      capabilities: manifest.capabilities,
      publisher: manifest.publisher,
      license: manifest.license,
      provenance: manifest.provenance,
      keyId: manifest.keyId ?? null,
      createdAt: manifest.createdAt,
      licenseFileIncluded: files.has("LICENSE.txt"),
      manifestSigPresent: Boolean(sigBytes),
      signature,
      manifestSha256: sha256(manifestBytes),
    },
  };
}
