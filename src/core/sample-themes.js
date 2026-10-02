// Sample theme builder: writes valid theme packages (zip) from curated
// definitions plus generated background art. Zero binary assets in the repo;
// art is deterministic (same inputs -> same bytes).
// The generic zip writer lives in zip-write.js (shared with the signing CLI).

import { buildZip } from "./zip-write.js";
import { encodePng, gradientBackground } from "./png.js";

export { buildZip };

// --- Curated sample themes ---------------------------------------------------

export const SAMPLE_THEMES = [
  {
    id: "aurora-veil",
    name: "Aurora Veil",
    tagline: "Calm green-to-violet gradient for late-night focus.",
    from: "#123a2f",
    to: "#3b1d5e",
    glow: { x: 0.72, y: 0.3, r: 0.5, strength: 0.3 },
    art: { focusX: 0.7, focusY: 0.35, safeArea: "right", taskMode: "ambient", dim: 0.45, taskDim: 0.7 },
    colors: {
      background: "#101820",
      panel: "rgba(16,24,32,0.72)",
      accent: "#34d399",
      text: "#e8f5ee",
      muted: "#9ab8ac",
      line: "rgba(52,211,153,0.25)",
    },
    css: `root {
  --ds-theme-surface-opacity: 0.72;
  --ds-theme-surface-blur: 8px;
}
sidebar {
  background-color: rgba(16, 24, 32, 0.4);
  border-color: rgba(52, 211, 153, 0.2);
}
composer {
  background-color: rgba(16, 24, 32, 0.55);
}`,
  },
  {
    id: "paper-light",
    name: "Paper Light",
    tagline: "A soft light theme for daytime work.",
    from: "#f5efe6",
    to: "#d9cfc0",
    glow: { x: 0.3, y: 0.25, r: 0.55, strength: 0.2 },
    art: { focusX: 0.3, focusY: 0.3, safeArea: "left", taskMode: "ambient", dim: 0.25, taskDim: 0.55 },
    colors: {
      background: "#f5efe6",
      panel: "rgba(255,255,255,0.78)",
      accent: "#b45309",
      text: "#292524",
      muted: "#78716c",
      line: "rgba(120,113,108,0.3)",
    },
    css: `root {
  --ds-theme-surface-opacity: 0.8;
  --ds-theme-surface-blur: 4px;
}
main {
  background-color: rgba(255, 255, 255, 0.5);
}`,
  },
  {
    id: "midnight-run",
    name: "Midnight Run",
    tagline: "Deep blue night theme with a cold glow.",
    from: "#0b1020",
    to: "#101f3c",
    glow: { x: 0.75, y: 0.7, r: 0.5, strength: 0.4 },
    art: { focusX: 0.75, focusY: 0.65, safeArea: "none", taskMode: "ambient", dim: 0.5, taskDim: 0.72 },
    colors: {
      background: "#0b1020",
      panel: "rgba(11,16,32,0.75)",
      accent: "#60a5fa",
      text: "#e2e8f0",
      muted: "#94a3b8",
      line: "rgba(96,165,250,0.22)",
    },
    css: null,
  },
];

/**
 * Build a complete, valid theme package zip for a sample theme.
 */
export function buildSampleThemeZip(sample, { width = 1600, height = 900 } = {}) {
  const rgba = gradientBackground(width, height, sample);
  const png = encodePng(width, height, rgba);

  const themeJson = {
    schemaVersion: 1,
    id: sample.id,
    name: sample.name,
    image: "background.png",
    appearance: "auto",
    art: sample.art,
    colors: sample.colors,
    tagline: sample.tagline,
    quote: "codexskin sample",
  };

  const entries = new Map();
  entries.set("theme.json", Buffer.from(JSON.stringify(themeJson, null, 2)));
  entries.set("background.png", png);
  if (sample.css) entries.set("theme.css", Buffer.from(sample.css, "utf8"));
  return buildZip(entries);
}
