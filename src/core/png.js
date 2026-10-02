// Dependency-free PNG encoder (truecolor, no compression tricks - zlib store mode).
// Enough for generated sample/placeholder backgrounds and tests; not a general
// image library. Also a tiny deterministic gradient generator.

import { deflateSync } from "node:zlib";

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

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
  return out;
}

/**
 * Encode an RGBA buffer (width*height*4 bytes, row-major, top-left origin)
 * as a PNG. Returns Buffer.
 */
export function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) throw new Error("png: buffer size mismatch");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Raw scanlines with filter byte 0 (None), then zlib-compressed.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 6 });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Deterministic diagonal gradient with a soft radial highlight - pleasant
 * sample art without any binary assets in the repo.
 */
export function gradientBackground(width, height, { from, to, glow } = {}) {
  const rgba = Buffer.alloc(width * height * 4);
  const c0 = parseColor(from ?? "#2b1a4a");
  const c1 = parseColor(to ?? "#0e7a6f");
  const gx = glow ? width * glow.x : width * 0.68;
  const gy = glow ? height * glow.y : height * 0.32;
  const gr = Math.max(width, height) * (glow?.r ?? 0.45);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = (x / width + y / height) / 2;
      const dx = x - gx;
      const dy = y - gy;
      const d = Math.sqrt(dx * dx + dy * dy) / gr;
      const glowAdd = Math.max(0, 1 - d) ** 2 * (glow?.strength ?? 0.35);
      const i = (y * width + x) * 4;
      rgba[i]     = Math.min(255, Math.round(c0[0] + (c1[0] - c0[0]) * t + glowAdd * 90));
      rgba[i + 1] = Math.min(255, Math.round(c0[1] + (c1[1] - c0[1]) * t + glowAdd * 85));
      rgba[i + 2] = Math.min(255, Math.round(c0[2] + (c1[2] - c0[2]) * t + glowAdd * 255));
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

function parseColor(hex) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) throw new Error(`png: bad color ${hex}`);
  return [
    parseInt(m[1].slice(0, 2), 16),
    parseInt(m[1].slice(2, 4), 16),
    parseInt(m[1].slice(4, 6), 16),
  ];
}
