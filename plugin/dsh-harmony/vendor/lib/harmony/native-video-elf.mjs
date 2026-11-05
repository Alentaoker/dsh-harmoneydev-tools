// Read symbol names only; never execute an ELF or require host LLVM utilities.
export function elfDynamicSymbols(bytes) {
  const bad = () => { throw new Error('Invalid ARM64 ELF dynamic symbol table'); };
  if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.length > 32 * 1024 * 1024
    || bytes.readUInt32BE(0) !== 0x7f454c46 || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 183) bad();
  const range = (offset, length) => { if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > bytes.length - length) bad(); };
  const u64 = offset => { range(offset, 8); const n = Number(bytes.readBigUInt64LE(offset)); if (!Number.isSafeInteger(n)) bad(); return n; };
  const table = u64(40), stride = bytes.readUInt16LE(58), count = bytes.readUInt16LE(60);
  if (stride < 64 || !count || count > 8192) bad();
  range(table, stride * count);
  const section = index => {
    if (index < 0 || index >= count) bad();
    const at = table + stride * index;
    return { type: bytes.readUInt32LE(at + 4), offset: u64(at + 24), size: u64(at + 32), link: bytes.readUInt32LE(at + 40), entrySize: u64(at + 56) };
  };
  const imports = new Set(), exports = new Set(); let found = false;
  for (let i = 0; i < count; i++) {
    const symbols = section(i); if (symbols.type !== 11) continue;
    found = true;
    if (symbols.entrySize !== 24 || symbols.size % 24) bad();
    range(symbols.offset, symbols.size);
    const strings = section(symbols.link); if (strings.type !== 3) bad();
    range(strings.offset, strings.size);
    for (let offset = symbols.offset; offset < symbols.offset + symbols.size; offset += 24) {
      const binding = bytes[offset + 4] >> 4, visibility = bytes[offset + 5] & 3;
      if ((binding !== 1 && binding !== 2) || (visibility !== 0 && visibility !== 3)) continue;
      const nameOffset = bytes.readUInt32LE(offset);
      if (nameOffset >= strings.size) bad();
      const start = strings.offset + nameOffset, end = bytes.indexOf(0, start);
      if (end < start || end >= strings.offset + strings.size || end - start > 4096) bad();
      const name = bytes.toString('utf8', start, end); if (!name) continue;
      if (bytes.readUInt16LE(offset + 6) !== 0) exports.add(name);
      else if (binding === 1) imports.add(name); // Undefined weak symbols may resolve to zero.
    }
  }
  if (!found) bad();
  return { imports, exports };
}

export const protobufImports = bytes => [...elfDynamicSymbols(bytes).imports].filter(name => name.includes('protobuf')).sort();

// Presence is a necessary ABI check, not proof of compatible object layouts or a working encoder.
export function matchNativeVideoResources(resources, exports) {
  return resources.map(resource => ({ resource, missing: resource.protobufSymbols.filter(name => !exports.has(name)) }));
}
