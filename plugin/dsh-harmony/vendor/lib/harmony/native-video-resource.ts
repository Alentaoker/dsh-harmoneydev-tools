import { createHash } from 'node:crypto';
import { lstat, readFile, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { HarmonyError } from './errors';
import { elfDynamicSymbols, protobufImports, matchNativeVideoResources } from './native-video-elf.mjs';

export type NativeVideoQuality = 'efficient' | 'balanced' | 'smooth';
export const NATIVE_VIDEO_PROFILES = {
  efficient: { scale: 3, fps: 15, bitRate: 1_572_864 },
  balanced: { scale: 2, fps: 24, bitRate: 3_145_728 },
  smooth: { scale: 2, fps: 30, bitRate: 6_291_456 },
} as const;
export function nativeVideoProfile(quality: NativeVideoQuality = 'balanced') {
  const profile = NATIVE_VIDEO_PROFILES[quality];
  if (!profile) throw new HarmonyError('INVALID_ARGUMENT', 'Unknown native video quality');
  return { ...profile, repeatInterval: Math.ceil(1000 / profile.fps) };
}
export type NativeVideoResource = { file: string; hash: string; resourceName: string; byteLength: number; id: string; protobufSymbols?: string[] };
type Resource = NativeVideoResource;
const resources = new Map<string, { fingerprint: string; result: Promise<Resource> }>();
/** Only the plugin-local resource is used. Importing a vendor archive is an explicit build-time step. */
export async function embeddedNativeVideoResource(resourceDirectory?: string): Promise<Resource> {
  return (await embeddedNativeVideoResources(resourceDirectory))[0];
}
export async function embeddedNativeVideoResources(resourceDirectory?: string): Promise<Resource[]> {
  const directory = resourceDirectory || process.env.DSH_HARMONY_NATIVE_VIDEO_DIR
    || (process.env.PIORA_WEB_RUNTIME_ROOT ? join(process.env.PIORA_WEB_RUNTIME_ROOT, 'resources', 'native-video') : undefined);
  if (!directory || !isAbsolute(directory)) throw new HarmonyError('CAPABILITY_UNAVAILABLE',
    '插件内置视频资源未配置。请导入原生视频组件后重新安装插件；截图和手机操作仍可使用。',
    { details: { reason: 'native-video-resource-missing' } });
  const manifestPath = join(directory, 'manifest.json');
  const manifestInfo = await lstat(manifestPath).catch(() => undefined);
  if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 8192) throw new HarmonyError('CAPABILITY_UNAVAILABLE',
    '插件内置视频资源清单缺失。', { details: { reason: 'native-video-resource-missing' } });
  let manifest: any;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch { throw new HarmonyError('INVALID_RESPONSE', 'Invalid embedded native video manifest'); }
  const variants = manifest.schemaVersion === 1 ? [{ ...manifest, id: 'legacy-manifest' }] : manifest.variants;
  if (![1, 2].includes(manifest.schemaVersion) || manifest.architecture !== 'aarch64'
    || !Array.isArray(variants) || !variants.length || variants.length > 4
    || new Set(variants.map(v => v?.fileName)).size !== variants.length
    || new Set(variants.map(v => v?.id)).size !== variants.length) {
    throw new HarmonyError('INVALID_RESPONSE', 'Invalid embedded native video manifest');
  }
  const output: Resource[] = [];
  for (const variant of variants) {
    if (!variant || !/^libdsh-native-video(?:-[a-zA-Z0-9._-]{1,40})?\.z\.so$/.test(variant.fileName)
      || (manifest.schemaVersion === 1 && variant.fileName !== 'libdsh-native-video.z.so')
      || typeof variant.id !== 'string' || !/^[a-z0-9-]{1,48}$/.test(variant.id)
      || !/^[a-f0-9]{64}$/.test(variant.sha256)
      || !Number.isSafeInteger(variant.byteLength) || variant.byteLength < 64 || variant.byteLength > 2 * 1024 * 1024
      || typeof variant.resourceName !== 'string' || variant.resourceName.length > 256) {
      throw new HarmonyError('INVALID_RESPONSE', 'Invalid embedded native video manifest');
    }
    const file = resolve(directory, variant.fileName);
    const info = await lstat(file).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink()) throw new HarmonyError('CAPABILITY_UNAVAILABLE',
      '插件缺少内置视频组件。请在安装时导入组件；无需在投屏时运行 DevEco Testing。',
      { details: { reason: 'native-video-resource-missing' } });
    if (info.size !== variant.byteLength) throw new HarmonyError('INVALID_RESPONSE', 'Embedded native video size mismatch');
    const fingerprint = `${manifest.schemaVersion}:${variant.id}:${variant.resourceName}:${variant.sha256}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    const cached = resources.get(file);
    if (cached?.fingerprint === fingerprint) { output.push(await cached.result); continue; }
    const result = (async () => {
      const bytes = await readFile(file);
      if (bytes.length !== variant.byteLength || bytes.readUInt32BE(0) !== 0x7f454c46
        || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 183
        || createHash('sha256').update(bytes).digest('hex') !== variant.sha256) {
        throw new HarmonyError('INVALID_RESPONSE', 'Embedded native video integrity or architecture mismatch');
      }
      const symbols = manifest.schemaVersion === 2 ? protobufImports(bytes) : undefined;
      if (symbols && !symbols.length) throw new HarmonyError('INVALID_RESPONSE', 'Native video protobuf requirements are missing');
      return { file, hash: variant.sha256, byteLength: bytes.length, resourceName: variant.resourceName, id: variant.id, protobufSymbols: symbols };
    })();
    if (resources.size >= 4) resources.clear();
    resources.set(file, { fingerprint, result });
    try { output.push(await result); }
    catch (error) { if (resources.get(file)?.result === result) resources.delete(file); throw error; }
  }
  return output;
}

/** Read the device's library, never change it or upload an executable to probe ABI. */
export async function selectNativeVideoResource(candidates: Resource[], command: (args: string[], operation: string, signal?: AbortSignal) => Promise<string>, signal?: AbortSignal) {
  if (signal?.aborted) throw new HarmonyError('COMMAND_ABORTED', 'Video ABI probe cancelled');
  if (!candidates.length) throw new HarmonyError('CAPABILITY_UNAVAILABLE', 'No native video resources');
  if (candidates.some(resource => !resource.protobufSymbols)) return { resource: candidates[0], abi: { status: 'legacy-manifest' } };
  const directory = await mkdtemp(join(tmpdir(), 'dsh-video-abi-'));
  let bytes: Buffer;
  try {
    const file = join(directory, 'libprotobuf.z.so');
    await command(['file', 'recv', '/system/lib64/libprotobuf.z.so', file], 'native_video_abi_probe', signal);
    if (signal?.aborted) throw new HarmonyError('COMMAND_ABORTED', 'Video ABI probe cancelled');
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 64 || info.size > 32 * 1024 * 1024) throw Error('Invalid device protobuf size');
    bytes = await readFile(file);
  } catch (error) {
    if (signal?.aborted || (error as HarmonyError)?.code === 'COMMAND_ABORTED') throw error;
    // Restricted firmware may allow loading but not reading system libraries.
    // Preserve the old default, and classify a later loader failure explicitly.
    const legacy = candidates.find(resource => resource.id === 'protobuf-legacy');
    if (!legacy) throw new HarmonyError('CAPABILITY_UNAVAILABLE', '无法读取设备视频依赖，不能选择兼容组件。', { details: { reason: 'native-video-abi-probe-unavailable' } });
    return { resource: legacy, abi: { status: 'unverified', reason: 'system-library-unreadable' } };
  } finally { await rm(directory, { recursive: true, force: true }); }
  if (signal?.aborted) throw new HarmonyError('COMMAND_ABORTED', 'Video ABI probe cancelled');
  let symbols: ReturnType<typeof elfDynamicSymbols>;
  try { symbols = elfDynamicSymbols(bytes); }
  catch { throw new HarmonyError('INVALID_RESPONSE', '设备 protobuf 库无法解析，未启动原生投屏。', { details: { reason: 'native-video-abi-probe-invalid' } }); }
  const matches = matchNativeVideoResources(candidates, symbols.exports);
  const match = matches.find(item => item.missing.length === 0);
  const abi = { status: 'symbols-matched', protobufSha256: createHash('sha256').update(bytes).digest('hex'),
    candidates: matches.map(item => ({ id: item.resource.id, missing: item.missing })) };
  if (!match) throw new HarmonyError('CAPABILITY_UNAVAILABLE', '设备 protobuf 与内置视频组件均不兼容，已保留兼容投屏。请更新匹配的原厂组件。',
    { details: { reason: 'native-video-abi-incompatible', abi } });
  return { resource: match.resource, abi };
}
