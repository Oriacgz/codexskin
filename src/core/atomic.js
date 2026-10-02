import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}

// A filesystem lock coordinates desktop, CLI, and service writers.
export async function withFileLock(file, action) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const deadline = Date.now() + 10_000;
  let handle;
  while (!handle) {
    try {
      handle = await fs.open(file, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
    } catch (error) {
      if (handle) {
        await handle.close();
        await fs.rm(file, { force: true });
        throw error;
      }
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(await fs.readFile(file, 'utf8'));
        if (pid > 0) {
          try { process.kill(pid, 0); }
          catch (probe) { if (probe.code === 'ESRCH') { await fs.rm(file, { force: true }); continue; } }
        }
      } catch (read) { if (read.code === 'ENOENT') continue; }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path.basename(file)}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try { return await action(); }
  finally { await handle.close(); await fs.rm(file, { force: true }); }
}
