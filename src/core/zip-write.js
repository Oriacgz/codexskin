// Deterministic zip writer (stored entries) - shared by sample theme builds
// and the `sign-manifest` CLI. Same module discipline as zip.js: exact
// structures, no cleverness. Deterministic output (fixed timestamps, zero
// external attrs) so signing workflows can reproduce archives bit-for-bit.

function crc32Table() {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
}
const CRC_TABLE = crc32Table();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Build a deterministic zip archive (stored entries) from Map<name, Buffer>.
 */
export function buildZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4);         // version needed
    local.writeUInt16LE(0, 6);          // flags
    local.writeUInt16LE(0, 8);          // method: stored
    local.writeUInt16LE(0, 10);         // mod time
    local.writeUInt16LE(0x21, 12);      // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    parts.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);    // central directory signature
    cd.writeUInt16LE(20, 4);            // version made by
    cd.writeUInt16LE(20, 6);            // version needed
    cd.writeUInt16LE(0, 8);             // flags
    cd.writeUInt16LE(0, 10);            // method: stored
    cd.writeUInt16LE(0, 12);            // mod time
    cd.writeUInt16LE(0x21, 14);         // mod date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);  // compressed size (stored)
    cd.writeUInt32LE(data.length, 24);  // uncompressed size
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);            // extra len
    cd.writeUInt16LE(0, 32);            // comment len
    cd.writeUInt16LE(0, 34);            // disk number
    cd.writeUInt16LE(0, 36);            // internal attrs
    cd.writeUInt32LE(0, 38);            // external attrs = 0 (plain regular file)
    cd.writeUInt32LE(offset, 42);       // local header offset
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);           // disk number
  eocd.writeUInt16LE(0, 6);           // disk with cd
  eocd.writeUInt16LE(entries.size, 8);
  eocd.writeUInt16LE(entries.size, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);     // cd offset
  eocd.writeUInt16LE(0, 20);          // comment len
  return Buffer.concat([...parts, cdBuf, eocd]);
}
