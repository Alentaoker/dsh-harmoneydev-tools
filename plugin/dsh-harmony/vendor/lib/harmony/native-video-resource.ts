import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { HarmonyError } from './errors';

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
type Resource = { file: string; hash: string; resourceName: string; byteLength: number };
const resources = new Map<string, { fingerprint: string; result: Promise<Resource> }>();
/** Only the plugin-local resource is used. Importing a vendor archive is an explicit build-time step. */
export async function embeddedNativeVideoResource(resourceDirectory?: string): Promise<Resource> {
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
  if (manifest.schemaVersion !== 1 || manifest.fileName !== 'libdsh-native-video.z.so'
    || manifest.architecture !== 'aarch64' || !/^[a-f0-9]{64}$/.test(manifest.sha256)
    || !Number.isSafeInteger(manifest.byteLength) || manifest.byteLength < 64 || manifest.byteLength > 2 * 1024 * 1024
    || typeof manifest.resourceName !== 'string' || manifest.resourceName.length > 256) {
    throw new HarmonyError('INVALID_RESPONSE', 'Invalid embedded native video manifest');
  }
  const file = resolve(directory, manifest.fileName);
  const info = await lstat(file).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) throw new HarmonyError('CAPABILITY_UNAVAILABLE',
    '插件缺少内置视频组件。请在安装时导入组件；无需在投屏时运行 DevEco Testing。',
    { details: { reason: 'native-video-resource-missing' } });
  if (info.size !== manifest.byteLength) throw new HarmonyError('INVALID_RESPONSE', 'Embedded native video size mismatch');
  const fingerprint = `${manifest.sha256}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  const cached = resources.get(file);
  if (cached?.fingerprint === fingerprint) return cached.result;
  const result = (async () => {
    const bytes = await readFile(file);
    if (bytes.length !== manifest.byteLength || bytes.readUInt32BE(0) !== 0x7f454c46
      || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 183
      || createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) {
      throw new HarmonyError('INVALID_RESPONSE', 'Embedded native video integrity or architecture mismatch');
    }
    return { file, hash: manifest.sha256, byteLength: bytes.length, resourceName: manifest.resourceName };
  })();
  if (resources.size >= 4) resources.clear();
  resources.set(file, { fingerprint, result });
  try { return await result; }
  catch (error) { if (resources.get(file)?.result === result) resources.delete(file); throw error; }
}
