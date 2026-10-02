import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  answerRestartConsent,
  askRestartConsent,
  autoRestartEnabled,
  readRestartConsent,
  setAutoRestart,
} from "../src/core/consent.js";

// Isolated data dir per test (paths.js reads CODEXSKIN_HOME lazily).
async function withTempHome(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cs-consent-"));
  const old = process.env.CODEXSKIN_HOME;
  process.env.CODEXSKIN_HOME = home;
  try {
    await fn(home);
  } finally {
    if (old === undefined) delete process.env.CODEXSKIN_HOME;
    else process.env.CODEXSKIN_HOME = old;
    await fs.rm(home, { recursive: true, force: true });
  }
}

test("consent: ask + read-deliver + answer flow persists auto-restart", async () => {
  await withTempHome(async () => {
    // No ask pending initially.
    assert.equal(await readRestartConsent(), null);

    // Watcher asks; ask is idempotent while fresh.
    await askRestartConsent({ reason: "watch" });
    await askRestartConsent({ reason: "watch" });

    // First poller gets the ask; second gets null (read-clears).
    const pending = await readRestartConsent();
    assert.equal(pending.open, true);
    assert.equal(pending.reason, "watch");
    assert.equal(await readRestartConsent(), null);

    // Answer "yes" persists the preference.
    const answered = await answerRestartConsent({ allowed: true });
    assert.equal(answered.ok, true);
    assert.equal(await autoRestartEnabled(), true);

    // User can revoke from the settings checkbox.
    await setAutoRestart(false);
    assert.equal(await autoRestartEnabled(), false);
    await setAutoRestart(true);
    assert.equal(await autoRestartEnabled(), true);
  });
});

test("consent: answering no disables auto-restart", async () => {
  await withTempHome(async () => {
    await setAutoRestart(true);
    await askRestartConsent({});
    await readRestartConsent();
    await answerRestartConsent({ allowed: false });
    assert.equal(await autoRestartEnabled(), false);
  });
});

test("consent: stale asks are not delivered", async () => {
  await withTempHome(async (home) => {
    const { dataDir } = await import("../src/core/paths.js");
    const pendingPath = path.join(dataDir(), "consent-restart.json");
    // Write an ask stamped 6 minutes ago (TTL is 5 minutes).
    await fs.writeFile(pendingPath, JSON.stringify({
      open: true, reason: "watch", at: Date.now() - 6 * 60 * 1000,
    }));
    assert.equal(await readRestartConsent(), null);
    // The stale file is also cleaned up.
    await assert.rejects(() => fs.access(pendingPath), /ENOENT/);
  });
});
