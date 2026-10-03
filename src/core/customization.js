import { createHash, randomUUID } from 'node:crypto';
import { detectImageMedia,inspectImage } from './image.js';
import { buildZip } from './zip-write.js';

const DEFAULTS = { imageMode: "fill", imageZoom: 100, imageX: 50, imageY: 50, textColorsEnabled: false, primaryTextColor: '#f4f6f8', secondaryTextColor: '#a1a8b0', brightness: 100, accent: '#b7f0ce', sidebarColor: '#191e22', sidebarOpacity: 80, sidebarDarkness: 0, chatColor: '#191e22', chatOpacity: 80, userMessageDarkness: 0, assistantMessageDarkness: 0, activityDarkness: 0, pageOpacity: 32, dialogOpacity: 65 };
// Composite the dark layer into one surface so navigation is not tinted twice.
export function sidebarSurface(settings) {
  const darkness = settings.sidebarDarkness / 100;
  const alpha = settings.sidebarOpacity / 100;
  const channels = [1, 3, 5].map((offset, index) => {
    const base = parseInt(settings.sidebarColor.slice(offset, offset + 2), 16);
    return Math.round(base * (1 - darkness) + [16, 19, 22][index] * darkness);
  });
  return `rgba(${channels.join(',')},${alpha})`;
}
export function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid theme settings');
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULTS, key)) throw new Error('Unknown theme setting: ' + key);
  const result = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = input[key] ?? fallback;
    if (typeof fallback === 'boolean') {
      if (typeof value !== 'boolean') throw new Error('Invalid ' + key);
    } else if (typeof fallback === 'number') {
      const min = key === 'brightness' ? 20 : key === 'imageZoom' ? 100 : 0, max = key === 'brightness' ? 180 : key === 'imageZoom' ? 250 : 100;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}`);
    } else if (key === 'imageMode') {
      if (!['fit','fill'].includes(value)) throw new Error('Invalid image mode');
    } else if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) throw new Error('Invalid ' + key + ' color');
    result[key] = typeof value === 'string' ? value.toLowerCase() : value;
  }
  return result;
}
export function defaultSettings(theme, css = '') {
  function surface(value, fallback) {
    if (/^#[\da-f]{6}$/i.test(value ?? '')) return { color: value, opacity: 100 };
    if (/^#[\da-f]{3}$/i.test(value ?? '')) return { color: '#' + [...value.slice(1)].map(c => c+c).join(''), opacity: 100 };
    const match = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(value ?? '');
    if (match) return { color: '#' + match.slice(1,4).map(v => Math.min(255,Number(v)).toString(16).padStart(2,'0')).join(''), opacity: Math.round(Number(match[4] ?? 1)*100) };
    return { color: fallback, opacity: 80 };
  }
  function partColor(part, fallback) {
    let value = fallback;
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (![part, `[data-ds-part="${part}"]`].includes(match[1].trim())) continue;
      const color = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/.exec(match[2]);
      if (color && !color[1].includes('var(')) value = color[1].trim();
    }
    return value;
  }
  const sidebar = surface(partColor('sidebar',theme.colors.panel),DEFAULTS.sidebarColor);
  const chat = surface(partColor('composer',theme.colors.panelAlt ?? theme.colors.panel),DEFAULTS.chatColor);
  if (theme.settings) return validateSettings(theme.settings);
  return { ...DEFAULTS, imageX: (theme.art?.focusX ?? .5)*100, imageY: (theme.art?.focusY ?? .5)*100, accent: surface(theme.colors.accent,DEFAULTS.accent).color, sidebarColor: sidebar.color, sidebarOpacity: sidebar.opacity, chatColor: chat.color, chatOpacity: chat.opacity };
}
export function customizePayload(payload, state) {
  const input = state.themeOverrides?.[payload.theme.id] ?? payload.theme.settings;
  const settings = input ? validateSettings({imageX:(payload.theme.art?.focusX ?? .5)*100,imageY:(payload.theme.art?.focusY ?? .5)*100,...input}) : null;
  const revision = createHash('sha256').update('surfaces-v23:' + JSON.stringify(settings)).digest('hex').slice(0, 16);
  return { ...payload, theme: { ...payload.theme, customization: settings, customizationRevision: revision, colors: settings ? { ...payload.theme.colors, accent: settings.accent } : payload.theme.colors } };
}
export function createCustomTheme(input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : null;
  if (typeof name !== 'string' || !name || name.length > 80 || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error('Choose a theme name (1–80 characters)');
  if (typeof input.image !== 'string' || input.image.length > Math.ceil(10 * 1024 * 1024 / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.image)) throw new Error('Invalid image; maximum 10 MiB');
  const bytes = Buffer.from(input.image, 'base64');
  if (bytes.length > 10 * 1024 * 1024) throw new Error('Image exceeds 10 MiB');
  const media = detectImageMedia(bytes);
  if (!media) throw new Error('Choose a PNG, JPEG or WebP image');
  inspectImage(bytes);
  const image = 'background.' + ({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'})[media];
  const theme = { schemaVersion: 1, id: 'custom-' + randomUUID(), name, image, art: { taskMode: 'full', dim: 0, taskDim: 0 }, colors: { text: '#eef4f1' } };
  const settings = validateSettings(input.settings);
  return { theme, settings, zip: buildZip(new Map([['theme.json', Buffer.from(JSON.stringify(theme))], [image, bytes]])) };
}

// Use the existing validated package format; only portable theme fields travel.
export function exportThemePackage(payload, settings, { duplicate = false, name } = {}) {
  const source = payload.theme;
  const themeName = name ?? source.name;
  if (typeof themeName !== 'string' || !themeName.trim() || themeName.length > 80 || /[\u0000-\u001f\u007f]/u.test(themeName)) throw new Error('Choose a theme name (1–80 characters)');
  const theme = { schemaVersion: 1, id: duplicate ? 'custom-' + randomUUID() : source.id, name: themeName.trim(), image: source.image, appearance: source.appearance, art: source.art, colors: source.colors, copy: source.copy, ...(settings ? {settings:validateSettings(settings)} : {}) };
  const image = Buffer.from(payload.dataUrl.split(',')[1], 'base64');
  const files = new Map([['theme.json', Buffer.from(JSON.stringify(theme))], [source.image, image]]);
  if (payload.css) files.set('theme.css', Buffer.from(payload.css));
  return { theme, zip: buildZip(files) };
}
