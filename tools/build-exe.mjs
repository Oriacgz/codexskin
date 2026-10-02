#!/usr/bin/env node
// Build a single-file codexskin-app.exe (Windows; adapt targets for macOS).
//
// Pipeline (Node Single Executable Applications):
//   1. esbuild bundles bin/codexskin-ui.mjs + the whole core into one CJS file
//   2. `node --experimental-sea-config` turns it into a SEA blob
//   3. postject injects the blob into a copy of the current node binary
//
// Requires: npm i -D esbuild postject  (build-time only; runtime stays zero-dep)

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { markWindowsGui } from './windows-gui.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(root, "build");
const distDir = path.join(root, "dist");
const entry = path.join(root, "bin", "codexskin-ui.mjs");
const bundle = path.join(buildDir, "ui-bundle.cjs");
const seaConfig = path.join(buildDir, "sea-config.json");
const blob = path.join(buildDir, "codexskin-ui.blob");
const isWin = process.platform === "win32";
const outputName = process.argv[2];
if (outputName && !/^[a-zA-Z0-9-]+(?:\.exe)?$/.test(outputName)) throw new Error('Output must be an executable filename');
const exeName = outputName ?? (isWin ? "codexskin-app.exe" : "codexskin-app");
const exePath = path.join(distDir, exeName);

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
}

async function main() {
  await fs.mkdir(buildDir, { recursive: true });
  await fs.mkdir(distDir, { recursive: true });
  // A release must carry the license of the exact embedded Node runtime.
  const nodeLicense = path.join(root, 'third-party-licenses', `Node-${process.version}-LICENSE.txt`);
  try { await fs.access(nodeLicense); }
  catch { throw new Error(`Missing Node ${process.version} license. See README build instructions.`); }

  // 1. Bundle
  const esbuild = (await import("esbuild")).default;
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: bundle,
    minify: false,
    sourcemap: false,
    logLevel: "info",
  });

  // 2. SEA blob
  await fs.writeFile(seaConfig, JSON.stringify({
    main: path.relative(root, bundle).replaceAll("\\", "/"),
    output: path.relative(root, blob).replaceAll("\\", "/"),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
  }, null, 2));
  run(process.execPath, ["--experimental-sea-config", seaConfig]);

  // 3. Copy node binary and inject (spawn postject's JS entry via node -
  // `npx` is a .cmd shim that spawnSync can't execute on Windows).
  await fs.copyFile(process.execPath, exePath);
  const postjectMain = path.join(root, "node_modules", "postject", "dist", "cli.js");
  await fs.access(postjectMain);
  run(process.execPath, [
    postjectMain, exePath,
    "NODE_SEA_BLOB", blob,
    "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ]);

  // Apply after resource injection so postject cannot rewrite the subsystem.
  if (isWin) await fs.writeFile(exePath, markWindowsGui(await fs.readFile(exePath)));

  for (const name of ['LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md']) {
    await fs.copyFile(path.join(root, name), path.join(distDir, name));
  }
  await fs.cp(path.join(root, 'third-party-licenses'), path.join(distDir, 'third-party-licenses'), { recursive: true });

  const stat = await fs.stat(exePath);
  console.log(`\nBuilt ${exePath} (${(stat.size / 1024 / 1024).toFixed(1)} MiB)`);
  console.log(`Run it: ${exePath} (opens the codexskin window)`);
}

main().catch((error) => {
  console.error("build failed:", error?.message ?? error);
  process.exit(1);
});
