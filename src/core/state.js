// State file helpers: dataDir/state.json tracks the active skin session.

import fs from "node:fs/promises";
import { statePath } from "./paths.js";
import { withFileLock, writeJsonAtomic } from './atomic.js';

export async function loadState() {
  try {
    const raw = await fs.readFile(statePath(), "utf8");
    const state = JSON.parse(raw);
    return typeof state === "object" && state !== null && !Array.isArray(state) ? state : {};
  } catch {
    return {};
  }
}

export async function saveState(state) {
  return withFileLock(`${statePath()}.lock`, () => writeJsonAtomic(statePath(), state));
}

export async function updateState(update) {
  return withFileLock(`${statePath()}.lock`, async () => {
    const current = await loadState();
    const next = typeof update === 'function' ? await update(current) : { ...current, ...update };
    await writeJsonAtomic(statePath(), next);
    return next;
  });
}
