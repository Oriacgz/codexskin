import { crc32 } from './crc32.js';
// Dependency-free ZIP reader for theme packages.
//
// Hard limits, fail closed:
//  - max 32 MiB compressed, 32 entries, 64 MiB expanded
//  - stored + deflate only (what every zip tool emits for these payloads)
//  - rejects entries with: absolute paths, `..` segments, backslashes,
//    directory entries, symlinks (external attrs), non-file modes
//  - per-file and total size caps enforced during inflate, not after

import { inflateRawSync } from "node:zlib";

export const ZIP_LIMITS = Object.freeze({
  maxArchiveBytes: 32 * 1024 * 1024,
  maxEntries: 32,
  maxEntryBytes: 16 * 1024 * 1024, // background image cap is 10 MiB, but stay generic
  maxTotalBytes: 64 * 1024 * 1024,
});

function fail(message) {
  throw new Error(`zip: ${message}`);
}

function checkName(name) {
  if (!name || name.length > 128) fail("unsafe entry name");
  if (name.includes("\\") || name.includes("\u0000")) fail("unsafe entry name");
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) fail("absolute path entry");
  const parts = name.split("/");
  if (parts.some((p) => p === "..")) fail("path traversal entry");
  if (parts.includes("") && name.endsWith("/")) return { name, isDir: true };
  if (parts.includes("")) fail("unsafe entry name");
  return { name, isDir: false };
}

/**
 * Parse a ZIP buffer, returning Map<name, Buffer> for file entries (sorted).
 * Throws on any structural anomaly - we never "best effort" a package.
 */
export function readZip(buffer, { maxTotalBytes = ZIP_LIMITS.maxTotalBytes } = {}) {
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 0 || maxTotalBytes > ZIP_LIMITS.maxTotalBytes) fail('invalid expansion budget');
  if (!Buffer.isBuffer(buffer)) fail("input must be a Buffer");
  if (buffer.length > ZIP_LIMITS.maxArchiveBytes) fail("archive too large");
  if (buffer.length < 22) fail("not a zip archive");

  // Locate End Of Central Directory (scan back over possible zip64-ish padding / comment)
  let eocd = -1;
  const minPos = Math.max(0, buffer.length - 22 - 65_536);
  for (let i = buffer.length - 22; i >= minPos; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) fail("end of central directory not found");

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  if (buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0
    || buffer.readUInt16LE(eocd + 8) !== entryCount) fail('multi-disk archive not supported');
  if (eocd + 22 + buffer.readUInt16LE(eocd + 20) !== buffer.length || cdOffset + cdSize !== eocd) fail('bad central directory bounds');
  if (entryCount > ZIP_LIMITS.maxEntries) fail(`more than ${ZIP_LIMITS.maxEntries} entries`);

  const files = new Map();
  let totalBytes = 0;
  let pos = cdOffset;

  for (let n = 0; n < entryCount; n += 1) {
    if (pos + 46 > eocd || buffer.readUInt32LE(pos) !== 0x02014b50) fail("bad central directory");
    const flags = buffer.readUInt16LE(pos + 8);
    const method = buffer.readUInt16LE(pos + 10);
    const crcExpected = buffer.readUInt32LE(pos + 16);
    const compSize = buffer.readUInt32LE(pos + 20);
    const expandedSize = buffer.readUInt32LE(pos + 24);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const externalAttrs = buffer.readUInt32LE(pos + 38);
    if (pos + 46 + nameLen + extraLen + commentLen > eocd) fail('bad central directory entry bounds');
    const rawName = buffer.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    pos += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) fail(`entry is encrypted: ${rawName}`);
    if (flags & 0x8) fail("data-descriptor entries are not supported; re-zip with sizes known");
    if (method !== 0 && method !== 8) fail(`unsupported compression method ${method}`);

    const { name, isDir } = checkName(rawName);
    if (isDir) continue;

    // Unix mode lives in the high 16 bits of external attrs. Reject dirs/symlinks
    // disguised as file entries - only plain regular files pass.
    const mode = (externalAttrs >>> 16) & 0xffff;
    if (mode !== 0) {
      const ftype = mode & 0o170000;
      if (ftype !== 0 && ftype !== 0o100000) fail(`entry is not a regular file: ${name}`);
    }

    // Local file header
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      fail("bad local header");
    }
    const lNameLen = buffer.readUInt16LE(localOffset + 26);
    const lExtraLen = buffer.readUInt16LE(localOffset + 28);
    if (buffer.readUInt16LE(localOffset + 6) !== flags || buffer.readUInt16LE(localOffset + 8) !== method
      || buffer.readUInt32LE(localOffset + 14) !== crcExpected
      || buffer.readUInt32LE(localOffset + 18) !== compSize
      || buffer.readUInt32LE(localOffset + 22) !== expandedSize
      || buffer.subarray(localOffset + 30, localOffset + 30 + lNameLen).toString('utf8') !== name) fail('local header mismatch');
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > cdOffset) fail("entry data out of bounds");
    if (expandedSize > ZIP_LIMITS.maxEntryBytes) fail(`entry too large: ${name}`);
    if (totalBytes + expandedSize > maxTotalBytes) fail('expanded archive too large');

    const comp = buffer.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) {
      data = Buffer.from(comp); // copy: comp is a view into the archive buffer
    } else {
      try {
        data = inflateRawSync(comp, { maxOutputLength: Math.max(1, Math.min(ZIP_LIMITS.maxEntryBytes, maxTotalBytes - totalBytes)) });
      } catch {
        fail(`corrupt deflate stream in ${name}`);
      }
    }
    if (data.length > ZIP_LIMITS.maxEntryBytes) fail(`entry too large: ${name}`);
    if (data.length !== expandedSize) fail(`expanded size mismatch: ${name}`);
    totalBytes += data.length;
    if (totalBytes > maxTotalBytes) fail("expanded archive too large");
    if (crc32(data) !== crcExpected) fail(`checksum mismatch for ${name}`);
    if (files.has(name)) fail(`duplicate entry: ${name}`);
    files.set(name, data);
  }

  if (pos !== eocd) fail('central directory size mismatch');
  return new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}
