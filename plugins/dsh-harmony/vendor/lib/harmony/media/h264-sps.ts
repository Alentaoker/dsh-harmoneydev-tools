/** Decode the visible dimensions in an AVC sequence parameter set (ITU-T H.264 7.4.2.1). */
export function h264SpsDimensions(nal: Uint8Array): { width: number; height: number } | undefined {
  try {
    if ((nal[0] & 31) !== 7 || nal.length < 5 || nal.length > 4096) return;
    const rbsp: number[] = [];
    for (let i = 1; i < nal.length; i++) {
      if (i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
      rbsp.push(nal[i]);
    }
    let offset = 0;
    const bits = (count: number): number => {
      if (count < 0 || count > 32 || offset + count > rbsp.length * 8) throw Error("SPS bit range");
      let value = 0;
      for (let i = 0; i < count; i++, offset++) value = value * 2 + ((rbsp[offset >> 3] >> (7 - (offset & 7))) & 1);
      return value;
    };
    const ue = (): number => { let leading = 0; while (!bits(1)) if (++leading > 24) throw Error("SPS Exp-Golomb range"); return 2 ** leading - 1 + bits(leading); };
    const se = (): number => { const value = ue(); return value % 2 ? (value + 1) / 2 : -value / 2; };
    const profile = bits(8); bits(8); bits(8); ue();
    let chroma = 1, separate = 0;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      chroma = ue(); if (chroma > 3) return;
      if (chroma === 3) separate = bits(1);
      ue(); ue(); bits(1);
      if (bits(1)) for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
        if (!bits(1)) continue;
        let last = 8, next = 8;
        for (let j = 0; j < (i < 6 ? 16 : 64); j++) { if (next) next = (last + se() + 256) % 256; last = next || last; }
      }
    }
    ue(); const order = ue();
    if (order === 0) ue();
    else if (order === 1) { bits(1); se(); se(); const cycle = ue(); if (cycle > 256) return; for (let i = 0; i < cycle; i++) se(); }
    else if (order > 2) return;
    ue(); bits(1);
    const mbWidth = ue() + 1, mapHeight = ue() + 1, frameOnly = bits(1);
    if (!frameOnly) bits(1);
    bits(1);
    let left = 0, right = 0, top = 0, bottom = 0;
    if (bits(1)) { left = ue(); right = ue(); top = ue(); bottom = ue(); }
    const chromaArray = separate ? 0 : chroma;
    const cropX = chromaArray === 0 || chromaArray === 3 ? 1 : 2;
    const cropY = (chromaArray === 1 ? 2 : 1) * (2 - frameOnly);
    const width = mbWidth * 16 - (left + right) * cropX;
    const height = mapHeight * 16 * (2 - frameOnly) - (top + bottom) * cropY;
    if (width < 1 || height < 1 || width > 16384 || height > 16384) return;
    return { width, height };
  } catch { return; }
}
