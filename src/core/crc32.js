// Shared ZIP/PNG checksum; integrity checking, not cryptographic authentication.
const table = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  table[n] = value;
}
export function crc32(bytes) {
  let value = -1;
  for (let index = 0; index < bytes.length; index++) value = table[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
  return (value ^ -1) >>> 0;
}
