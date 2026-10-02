import {syncNativeAppearance} from './appearance-sync.js';
// Renderer payload: the JavaScript evaluated inside the Codex renderer over CDP.
//
// Contract (version 1):
//  - one <style id="codexskin-style"> element, rebuilt on every apply
//  - one #codexskin-layer background div with the theme image as a data: URL
//  - html[data-codexskin="active"] attributes drive all styling
//  - verify() checks observable DOM state, not just element existence
//  - restore() removes everything and reports whether the page looks untouched

import { sidebarSurface } from './customization.js';

export const PAYLOAD_VERSION = 1;

const LAYER_ID = "codexskin-layer";
const STYLE_ID = "codexskin-style";

/**
 * Theme CSS part -> real Codex DOM selectors. The safe-CSS subset speaks in
 * symbolic parts (`sidebar`, `[data-ds-part="composer"]`); this map is where
 * they anchor to the app. If a Codex update shifts its DOM, ONLY these lines
 * need updating - themes keep working.
 */
const PART_SELECTORS = {
  root: "html",
  sidebar: "aside[class*=\"app-shell-left-panel\"], [class*=\"_LeftPanel_\"]",
  main: "[role=\"main\"], main",
  header: "header",
  home: "[data-testid=\"home-icon\"], [class*=\"_HomeShell_\"]",
  "home-hero": "[class*=\"_homeUtilityBar_\"], [class*=\"_HomeHero_\"]",
  "project-list": "[class*=\"project-selector\"], [class*=\"_ProjectSelector_\"]",
  thread: ".thread-scroll-container, [class*=\"_ThreadScroll_\"]",
  message: "[data-message-author-role], [class*=\"_markdown\"]",
  composer: "[class*=\"_ComposerLayoutRoot_\"], [class*=\"_ComposerLayoutBody_\"], [class*=\"composer-surface-chrome\"]",
  "composer-toolbar": "[class*=\"_ComposerLayoutFooter_\"], [class*=\"_footer_\"]",
  dialog: "[role=\"dialog\"], [data-radix-popper-content-wrapper]",
};

function buildStyleCss(theme, css) {
  const a = theme.art;
  const colors = theme.colors;
  // NOTE: the background image is set inline on the layer element (see apply),
  // never in this stylesheet - keeps the style block small and avoids
  // duplicating a multi-megabyte data: URL in two places.
  const vars = [
    `--cs-focus-x: ${a.focusX * 100}%`,
    `--cs-focus-y: ${a.focusY * 100}%`,
    `--cs-dim: ${a.dim}`,
    `--cs-task-dim: ${a.taskDim}`,
    `--cs-blur: ${a.blur}px`,
    `--cs-name: ${JSON.stringify(theme.name)}`,
  ];
  for (const [k, v] of Object.entries(colors)) {
    if (v) vars.push(`--cs-color-${k}: ${v}`);
  }
  // Official DreamSkin variable names: official themes' safe-css references
  // these via var(), so we define them alongside our --cs-* set. Unset
  // palette keys get a transparent-ish default so var() never resolves to
  // nothing (which would make declarations invalid at computed-value time).
  const official = [
    ["--ds-theme-color-background", colors.background],
    ["--ds-theme-color-panel", colors.panel],
    ["--ds-theme-color-panel-alt", colors.panelAlt],
    ["--ds-theme-color-accent", colors.accent],
    ["--ds-theme-color-accent-alt", colors.accentAlt],
    ["--ds-theme-color-secondary", colors.secondary],
    ["--ds-theme-color-highlight", colors.highlight],
    ["--ds-theme-color-text", colors.text],
    ["--ds-theme-color-muted", colors.muted],
    ["--ds-theme-color-line", colors.line],
  ];
  for (const [name, value] of official) {
    vars.push(value ? `${name}: ${value}` : `${name}: transparent`);
  }
  vars.push(
    "--ds-theme-font-family: inherit",
    "--ds-theme-font-scale: 1",
    "--ds-theme-surface-opacity: 1",
    "--ds-theme-surface-blur: 0px",
    "--ds-theme-surface-radius: 0px",
    "--ds-theme-surface-border-alpha: 1",
    "--ds-theme-surface-shadow: none",
    `--ds-theme-image-focus-x: ${a.focusX}`,
    `--ds-theme-image-focus-y: ${a.focusY}`,
    "--ds-theme-image-zoom: 1",
    "--ds-theme-image-dim: 0",
    "--ds-theme-image-task-intensity: 0",
    "--ds-theme-density-scale: 1",
    "--ds-theme-motion-level: 1",
  );
  let out = `
html[data-codexskin="active"] { ${vars.join("; ")}; }
#${LAYER_ID} {
  position: fixed; inset: 0; z-index: 2147483646; pointer-events: none;
  background-image: var(--cs-image);
  background-size: cover;
  background-position: var(--cs-focus-x) var(--cs-focus-y);
  opacity: 1;
}
html[data-codexskin-mode="task"] #${LAYER_ID} {
  opacity: ${a.taskMode === 'off' ? '0' : a.taskMode === 'full' ? 'calc(1 - var(--cs-dim))' : 'calc(1 - var(--cs-task-dim))'};
  filter: blur(var(--cs-blur));
}
html[data-codexskin-mode="home"] #${LAYER_ID} { opacity: calc(1 - var(--cs-dim)); }
html[data-codexskin="active"] body { background: transparent !important; }
html[data-codexskin="active"] [class*="app-shell"] { background: transparent !important; }
#${STYLE_ID} { display: none; }
`;
  if (css) out += rewriteThemeCss(css);
  out += 'html[data-codexskin="active"] [data-automation-card] > button { background-color: rgba(16,19,22,.32) !important; border-color: rgba(255,255,255,.18) !important; }';
  out += 'html[data-codexskin="active"] [data-automation-card] > button:hover { background-color: rgba(16,19,22,.42) !important; }';
  if (theme.customization) {
    const c = theme.customization;
    const rgba = (hex, opacity) => 'rgba(' + [1,3,5].map(i => parseInt(hex.slice(i,i+2),16)).join(',') + ',' + opacity / 100 + ')';
    // Tint one message body, never its nested markdown, code, or tool cards.
    const messageSurfaces = [
      ['.bg-user-message, [data-message-author-role="user"]:not(:has(.bg-user-message))', c.userMessageDarkness],
      ['[data-markdown-text-style="assistant-message"]:not(:empty), [data-message-author-role="assistant"]:not(:has([data-markdown-text-style="assistant-message"]))', c.assistantMessageDarkness],
      ['.thread-scroll-container .text-size-chat.text-secondary:has(> button[aria-expanded]), .thread-scroll-container [class~="group/agent-activity"] .text-size-chat.text-secondary.overflow-hidden, [data-markdown-text-style="thinking"], [data-markdown-text-style="reasoning"]', c.activityDarkness, true],
    ];
    for (const [selectors, darkness, activity] of messageSurfaces) {
      if (!(darkness > 0)) continue;
      for (const selector of selectors.split(',')) {
        const scoped = 'html[data-codexskin="active"] ' + selector.trim();
        out += scoped + ' { background: ' + rgba('#101316', darkness) + ' !important; color: #f4f6f8 !important; border: 1px solid rgba(255,255,255,.12) !important; border-radius: 14px !important; padding: 12px 16px !important; box-sizing: border-box; min-width: 0; overflow-wrap: anywhere; box-shadow: none !important; }';
        out += scoped + ' :where(p,li,blockquote,h1,h2,h3,h4,h5,h6,strong,em) { color: inherit !important; }';
        out += scoped + ' a { color: ' + c.accent + ' !important; }';
        if (activity) {
          out += scoped + ' :where(button,span) { color: #f4f6f8 !important; opacity: 1 !important; -webkit-text-fill-color: #f4f6f8 !important; }';
        }
      }
    }
    out += 'html[data-codexskin="active"] { isolation: isolate; --color-accent: ' + c.accent + '; --color-accent-primary: ' + c.accent + '; }';
    if (c.textColorsEnabled) {
      const scope = 'html[data-codexskin="active"]';
      out += scope + ', ' + scope + ' body, ' + scope + ' [data-theme] { --color-text: ' + c.primaryTextColor + ' !important; --color-text-primary: ' + c.primaryTextColor + ' !important; --color-text-secondary: ' + c.secondaryTextColor + ' !important; --color-text-tertiary: ' + c.secondaryTextColor + ' !important; --color-icon-secondary: ' + c.secondaryTextColor + '; --color-icon-tertiary: ' + c.secondaryTextColor + '; --ds-theme-color-text: ' + c.primaryTextColor + '; --ds-theme-color-muted: ' + c.secondaryTextColor + '; color: ' + c.primaryTextColor + '; }';
    }
    out += '#codexskin-layer { z-index: -1; filter: brightness(' + c.brightness / 100 + ') blur(' + a.blur + 'px) !important; }';
    // The editor controls image brightness directly. Legacy dim/taskDim must
    // not also blend the image with the app background and wash out its colors.
    out += 'html[data-codexskin="active"] #codexskin-layer { opacity: 1 !important; }';
    if (a.taskMode === 'off') out += 'html[data-codexskin="active"][data-codexskin-mode="task"] #codexskin-layer { opacity: 0 !important; }';
    for (const [part,color,opacity] of [['sidebar',c.sidebarColor,c.sidebarOpacity],['composer',c.chatColor,c.chatOpacity]]) {
      const background = part === 'sidebar' ? sidebarSurface(c) : rgba(color,opacity);
      for (const selector of PART_SELECTORS[part].split(',')) {
        const scoped = 'html[data-codexskin="active"] ' + selector.trim();
        out += scoped + ' { background: ' + background + ' !important; backdrop-filter: blur(' + (opacity < 100 && (part !== 'sidebar' || c.sidebarDarkness < 100) ? 12 : 0) + 'px) !important; }';
        if (part === 'sidebar' && c.sidebarDarkness > 0) {
          out += scoped + ' { color: #f4f6f8 !important; --color-text-primary: #f4f6f8; --color-text-secondary: #d1d8df; }';
          out += scoped + ' :where(a,button,p,span) { color: inherit !important; }';
        }
      }
    }
    // Codex paints additional navigation and footer surfaces beneath these
    // controls. Leaving them opaque defeats the user-selected alpha.
    for (const selector of PART_SELECTORS.sidebar.split(',')) {
      out += 'html[data-codexskin="active"] ' + selector.trim() + ' .sidebar-navigation { background: transparent !important; }';
    }
    out += 'html[data-codexskin="active"] [data-thread-scroll-footer="true"], html[data-codexskin="active"] [data-thread-scroll-footer="true"] .pointer-events-none.absolute.inset-x-0 { background: transparent !important; }';
    // The scroll spacer carries a separate fade above the footer itself.
    out += 'html[data-codexskin="active"] .thread-scroll-container .pointer-events-none.absolute.inset-x-0.from-surface { background: transparent !important; }';
    out += 'html[data-codexskin="active"] [class*="_MainContentTopFade_"] { background: transparent !important; box-shadow: none !important; }';
    out += 'html[data-codexskin="active"] [class*="_ComposerLayoutRoot_"], html[data-codexskin="active"] [class*="composer-surface-chrome"] { box-shadow: none !important; }';
    // When a chrome wrapper sits inside the composer root, tint only once.
    out += 'html[data-codexskin="active"] [class*="_ComposerLayoutRoot_"] [class*="composer-surface-chrome"] { background: transparent !important; backdrop-filter: none !important; }';
    out += 'html[data-codexskin="active"] button[type="submit"] { background-color: ' + c.accent + ' !important; color: #101316 !important; }';
    out += 'html[data-codexskin="active"] aside [aria-current="page"] { color: ' + c.accent + ' !important; }';
    out += 'html[data-codexskin="active"] [role="main"], html[data-codexskin="active"] main { background: transparent !important; }';
    // Full-page routes use shared shell surfaces rather than main elements.
    for (const selector of ['[data-app-shell-main-surface="default"]', '[class*="_FullHeightPageSurfaceLayout_"]', '[class*="_PageSurface_"]', '[class*="_WorkspaceContent_"]::before', '[data-app-shell-workspace-row]::before']) {
      out += 'html[data-codexskin="active"] ' + selector + ' { background: transparent !important; }';
    }
    for (const selector of ['[data-app-shell-page-header]', '[data-app-shell-main-titlebar]']) {
      out += 'html[data-codexskin="active"] ' + selector + ' { background: ' + sidebarSurface(c) + ' !important; }';
    }
    // Image-generation and other composers paint their rounded body separately.
    out += 'html[data-codexskin="active"] [class*="_ComposerLayoutRoot_"] { --composer-layout-surface-background: transparent; --composer-layout-surface-shadow: none; }';
    out += 'html[data-codexskin="active"] [class*="_ComposerLayoutRoot_"]:has([class*="_ComposerLayoutBody_"]) { background: transparent !important; backdrop-filter: none !important; }';
  }
  if (theme.customization?.textColorsEnabled) {
    const c = theme.customization;
    // Override readability's automatic light text without recoloring code or links.
    out += 'html[data-codexskin="active"] :where(.text-default, .text-primary, .text-token-text-primary, .bg-user-message, [data-message-author-role], [data-markdown-text-style="assistant-message"]) { color: ' + c.primaryTextColor + ' !important; }';
    out += 'html[data-codexskin="active"] :where(.text-secondary, .text-tertiary, .text-token-text-secondary, .text-token-text-tertiary, [data-markdown-text-style="thinking"], [data-markdown-text-style="reasoning"]) { color: ' + c.secondaryTextColor + ' !important; }';
    out += 'html[data-codexskin="active"] .thread-scroll-container .text-size-chat.text-secondary :where(button,span) { color: ' + c.secondaryTextColor + ' !important; -webkit-text-fill-color: ' + c.secondaryTextColor + ' !important; }';
    out += 'html[data-codexskin="active"] :where(input,textarea)::placeholder { color: ' + c.secondaryTextColor + ' !important; opacity: 1 !important; }';
    out += 'html[data-codexskin="active"] :where(.ProseMirror, [contenteditable="true"]) :where([data-placeholder])::before { color: ' + c.secondaryTextColor + ' !important; opacity: 1 !important; }';
    out += 'html[data-codexskin="active"] :where(.text-secondary,.text-tertiary) svg { color: ' + c.secondaryTextColor + ' !important; }';
    // Native tooltips have a separate palette and are rendered through portals.
    out += 'html[data-codexskin="active"] { --tooltip-text-color: ' + c.primaryTextColor + ' !important; --tooltip-compact-text-color: ' + c.primaryTextColor + ' !important; --tooltip-compact-interactive-text-color-hover: ' + c.primaryTextColor + ' !important; --color-text-tooltip: ' + c.primaryTextColor + ' !important; --color-text-tooltip-classic: ' + c.primaryTextColor + ' !important; }';
    out += 'html[data-codexskin="active"] :is([role="tooltip"], [class*="_Tooltip_"]) { color: ' + c.primaryTextColor + ' !important; }';
    out += 'html[data-codexskin="active"] :is([role="tooltip"], [class*="_Tooltip_"]) :is(.text-secondary,.text-tertiary,[class*="text-text/"]) { color: ' + c.secondaryTextColor + ' !important; }';
    // Activity labels use alpha text utilities and animated shimmer, not text-secondary.
    out += 'html[data-codexskin="active"] .thread-scroll-container :is([class*="text-text/"], [class*="_cadencedShimmer_"]), html[data-codexskin="active"] .thread-scroll-container [class*="text-text/"] :where(span,svg) { color: ' + c.secondaryTextColor + ' !important; -webkit-text-fill-color: ' + c.secondaryTextColor + ' !important; }';
    out += 'html[data-codexskin="active"] .thread-scroll-container [class*="_cadencedShimmerSweep_"] { display: none !important; }';
    out += 'html[data-codexskin="active"] .thread-scroll-container :where(pre,code) { color: ' + c.primaryTextColor + '; }';
    for (const selector of PART_SELECTORS.sidebar.split(',')) {
      out += 'html[data-codexskin="active"] ' + selector.trim() + ' { --color-text-primary: ' + c.primaryTextColor + ' !important; --color-text-secondary: ' + c.secondaryTextColor + ' !important; --color-text-tertiary: ' + c.secondaryTextColor + ' !important; color: ' + c.primaryTextColor + ' !important; }';
      out += 'html[data-codexskin="active"] ' + selector.trim() + ' :where(.text-secondary,.text-tertiary) { color: ' + c.secondaryTextColor + ' !important; }';
    }
  }
  return out;
}

/**
 * Rewrite validated theme CSS into renderer CSS:
 *   [data-ds-part="sidebar"]:hover -> sidebar:hover -> real DOM selectors + :hover
 * The input is already subset-validated, so this is a mechanical translation,
 * not a security boundary. Each part rule is emitted once per DOM selector;
 * rules whose part has no anchor here are skipped.
 */
function rewriteThemeCss(css) {
  let out = "";
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of css.matchAll(rulePattern)) {
    const selector = match[1].trim();
    const body = match[2].trim();
    if (!body) continue;
    const stateMatch = /^(.*?)(?::(hover|focus-visible))?$/.exec(selector);
    const rawPart = (stateMatch?.[1] ?? selector).trim();
    const state = stateMatch?.[2] ?? null;
    const bare = /^\[data-ds-part="([a-z-]+)"\]$/.exec(rawPart)?.[1] ?? rawPart;
    const domSelector = PART_SELECTORS[bare];
    if (!domSelector) continue;
    for (const piece of domSelector.split(",")) {
      const scoped = `html[data-codexskin="active"]${bare === 'root' ? '' : ` ${piece.trim()}`}${state ? `:${state}` : ""}`;
      out += `${scoped} { ${body} }\n`;
    }
  }
  return out;
}

/**
 * Build the expression that (re)applies a theme in the renderer.
 * `theme.dataUrl` must already be a data: URL string; `css` is validated safe-css.
 */
export function buildApplyExpression(theme, css) {
  const styleCss = buildStyleCss(theme, css);
  return `(async function () {
  const DATA_URL = ${JSON.stringify(theme.dataUrl)};
  const THEME = ${JSON.stringify({ ...theme, dataUrl: null })};
  const STYLE_CSS = ${JSON.stringify(styleCss)};
  const LAYER_ID = ${JSON.stringify(LAYER_ID)};
  const STYLE_ID = ${JSON.stringify(STYLE_ID)};
  const nativeAppearance = THEME.customization && typeof location !== 'undefined' && /^app:/.test(location.href) ? await (${syncNativeAppearance.toString()})(THEME.customization) : null;

  // Decode before publishing an applied theme; magic bytes alone do not prove
  // that a background is a renderable image.
  if (typeof Image === 'function') {
    const image = new Image();
    image.src = DATA_URL;
    await image.decode();
  }

  let layer = document.getElementById(LAYER_ID);
  if (!layer) {
    layer = document.createElement("div");
    layer.id = LAYER_ID;
    layer.setAttribute("aria-hidden", "true");
    document.documentElement.appendChild(layer);
  }
  layer.style.setProperty("background-image", 'url("' + DATA_URL + '")');

  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.documentElement.appendChild(style);
  }
  style.textContent = STYLE_CSS;

  document.documentElement.setAttribute("data-codexskin", "active");
  document.documentElement.setAttribute("data-codexskin-theme", THEME.id);
  document.documentElement.setAttribute("data-codexskin-mode",
    window.location.hash.includes("home") ? "home" : "task");

  window.__codexskin = { version: ${PAYLOAD_VERSION}, themeId: THEME.id,
    image: DATA_URL, customizationRevision: THEME.customizationRevision, taskMode: THEME.art.taskMode, appliedAt: Date.now() };
  return { ok: true, themeId: THEME.id, nativeAppearance };
})();`;
}

/**
 * Build the expression that verifies the theme is actually observable in the DOM.
 * Returns { active, themeId, layerVisible, styleAttached }.
 */
export function buildVerifyExpression(themeId, revision) {
  return `(function () {
  const root = document.documentElement;
  const layer = document.getElementById("codexskin-layer");
  const style = document.getElementById("codexskin-style");
  const mode = window.location.hash.includes("home") ? "home" : "task";
  root.setAttribute("data-codexskin-mode", mode);
  const active = root.getAttribute("data-codexskin") === "active";
  const revisionMatches = ${revision === undefined ? "true" : `window.__codexskin?.customizationRevision === ${JSON.stringify(revision)}`};
  const themeMatches = root.getAttribute("data-codexskin-theme") === ${JSON.stringify(themeId)};
  const computed = layer && typeof getComputedStyle === 'function' ? getComputedStyle(layer) : layer?.style;
  const imagePresent = !!computed?.backgroundImage && computed.backgroundImage !== 'none';
  const intentionallyHidden = mode === 'task' && window.__codexskin?.taskMode === 'off';
  const layerVisible = !!layer && layer.getBoundingClientRect().height > 0
    && imagePresent && computed?.display !== 'none' && computed?.visibility !== 'hidden'
    && (intentionallyHidden || Number(computed?.opacity ?? 1) > 0);
  const styleAttached = !!style && (style.textContent || "").length > 0;
  return { active, themeId: root.getAttribute("data-codexskin-theme"), themeMatches,
           layerVisible, styleAttached,
           ok: active && themeMatches && revisionMatches && layerVisible && styleAttached };
})();`;
}

/**
 * Build the expression that removes every trace of the skin.
 * Returns { ok, removed }.
 */
export function buildCompatibilityExpression(themeId) {
  return `(function () {
    const verification = ${buildVerifyExpression(themeId)};
    const selectors = ${JSON.stringify(PART_SELECTORS)};
    const targets = Object.fromEntries(Object.entries(selectors).map(([name, selector]) =>
      [name, document.querySelectorAll(selector).length]));
    const pageSurface = !!document.querySelector('[data-app-shell-main-surface], [class*="_PageSurface_"]');
    const warnings = [];
    if (!verification.ok) warnings.push('Selected theme is not fully applied. Re-apply the theme.');
    if (!targets.main && !pageSurface) warnings.push('Main surface selector was not found; this page may need a compatibility update.');
    if (targets.thread && !targets.composer) warnings.push('Chat input selector was not found. It may be hidden, or Codex styling has changed.');
    return { verification, targets, warnings };
  })();`;
}

export function buildRestoreExpression() {
  return `(function () {
  const root = document.documentElement;
  root.removeAttribute("data-codexskin");
  root.removeAttribute("data-codexskin-theme");
  root.removeAttribute("data-codexskin-mode");
  let removed = 0;
  for (const id of ["codexskin-layer", "codexskin-style"]) {
    const el = document.getElementById(id);
    if (el) { el.remove(); removed += 1; }
  }
  if (window.__codexskin) { delete window.__codexskin; removed += 1; }
  return { ok: true, removed };
})();`;
}
