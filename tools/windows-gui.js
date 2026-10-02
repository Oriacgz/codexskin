// Set IMAGE_OPTIONAL_HEADER.Subsystem to IMAGE_SUBSYSTEM_WINDOWS_GUI.
// Windows then starts the desktop executable without allocating a console.
export function markWindowsGui(bytes) {
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error('Invalid DOS header');
  const pe = bytes.readUInt32LE(0x3c);
  if (pe > bytes.length - 24 || bytes.readUInt32LE(pe) !== 0x4550) throw new Error('Invalid PE header');
  const optional = pe + 24;
  const size = bytes.readUInt16LE(pe + 20);
  if (size < 70 || optional + size > bytes.length) throw new Error('Invalid optional header');
  if (![0x10b, 0x20b].includes(bytes.readUInt16LE(optional))) throw new Error('Unsupported PE format');
  bytes.writeUInt16LE(2, optional + 68);
  return bytes;
}
