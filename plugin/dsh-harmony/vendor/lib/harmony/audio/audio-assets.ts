import { createHash } from "node:crypto";
import { lstat, mkdir, writeFile, utimes } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { readBoundedRegularFile, enforceArtifactQuota } from "../runtime/bounded-file";
import { HarmonyError } from "../errors";

export interface AudioAsset { id: string; hash: string; durationMs: number; sampleRate: number; channels: number; bitsPerSample: 16; bytes: number }
const maxBytes = 8 * 1024 * 1024;
export function parsePcmWav(data: Buffer): Omit<AudioAsset, "id" | "hash"> & { pcmOffset: number; pcmBytes: number } {
  const bad = () => new HarmonyError("INVALID_ARGUMENT", "Audio must be a bounded 16-bit PCM WAV (mono/stereo, 8–48 kHz, at most 30 seconds)");
  if (data.length < 44 || data.length > maxBytes || data.toString("ascii", 0,4) !== "RIFF" || data.toString("ascii",8,12) !== "WAVE" || data.readUInt32LE(4) + 8 !== data.length) throw bad();
  let format: { channels: number; sampleRate: number; blockAlign: number } | undefined;
  let pcmOffset = 0, pcmBytes = 0;
  for (let offset = 12; offset + 8 <= data.length;) {
    const name = data.toString("ascii", offset, offset+4), size = data.readUInt32LE(offset+4), start = offset+8;
    if (size > data.length - start) throw bad();
    if (name === "fmt ") {
      if (format || size < 16 || data.readUInt16LE(start) !== 1 || data.readUInt16LE(start+14) !== 16) throw bad();
      const channels = data.readUInt16LE(start+2), sampleRate = data.readUInt32LE(start+4), blockAlign = data.readUInt16LE(start+12);
      if (![1,2].includes(channels) || ![8000,16000,22050,24000,32000,44100,48000].includes(sampleRate) || blockAlign !== channels*2 || data.readUInt32LE(start+8) !== sampleRate*blockAlign) throw bad();
      format = { channels, sampleRate, blockAlign };
    } else if (name === "data") { if (pcmOffset) throw bad(); pcmOffset = start; pcmBytes = size; }
    offset = start + size + (size % 2);
    if (offset > data.length) throw bad();
  }
  if (!format || !pcmBytes || pcmBytes % format.blockAlign) throw bad();
  const durationMs = pcmBytes * 1000 / (format.sampleRate*format.blockAlign);
  if (durationMs < 50 || durationMs > 30_000) throw bad();
  return { durationMs, sampleRate: format.sampleRate, channels: format.channels, bitsPerSample: 16, bytes: data.length, pcmOffset, pcmBytes };
}
export class AudioAssetStore {
  constructor(private readonly directory: string) {}
  async import(path: string): Promise<AudioAsset> {
    if (!isAbsolute(path)) throw new HarmonyError("INVALID_ARGUMENT", "Audio source must be a local regular file without symlink traversal");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new HarmonyError("INVALID_ARGUMENT", "Audio source is invalid or too large");
    const data = await readBoundedRegularFile(path, maxBytes);
    const parsed = parsePcmWav(data), hash = createHash("sha256").update(data).digest("hex");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await lstat(this.directory)).isSymbolicLink()) throw new HarmonyError("INVALID_ARGUMENT", "Audio store cannot be a symlink");
    await enforceArtifactQuota(this.directory, "wav", data.length);
    const target = join(this.directory, `${hash}.wav`);
    try { await writeFile(target, data, { flag: "wx", mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await this.resolve(hash);
    return { id: hash, hash, durationMs: parsed.durationMs, sampleRate: parsed.sampleRate, channels: parsed.channels, bitsPerSample: 16, bytes: data.length };
  }
  async resolve(id: string): Promise<{ path: string; asset: AudioAsset }> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid audio asset ID");
    const path = join(this.directory, `${id}.wav`), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new HarmonyError("INVALID_ARGUMENT", "Invalid stored audio asset");
    const data = await readBoundedRegularFile(path, maxBytes), hash = createHash("sha256").update(data).digest("hex");
    if (hash !== id) throw new HarmonyError("INVALID_ARGUMENT", "Audio bytes changed after import");
    const parsed = parsePcmWav(data);
    await utimes(path, new Date(), new Date());
    return { path, asset: { id, hash, durationMs: parsed.durationMs, sampleRate: parsed.sampleRate, channels: parsed.channels, bitsPerSample: 16, bytes: data.length } };
  }
}
