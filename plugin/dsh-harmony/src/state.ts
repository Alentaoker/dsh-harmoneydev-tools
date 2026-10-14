import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const dataRoot = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'dshHarmony');
let host: any;
export function setHost(ctx: any) { host = ctx; }
export function getHost(): any { if (!host) throw new Error('dshHarmony host is not active'); return host; }
/** Plugin-local environment: never mutates the Harness process environment. */
export function harmonyEnvironment() {
  return {
    ...process.env,
    PIORA_WEB_RUNTIME_ROOT: pluginRoot,
    PIORA_DESKTOP_DATA_DIR: dataRoot,
    PIORA_HARMONY_CONFIG_PATH: join(dataRoot, 'harmony.json'),
    PIORA_HARMONY_TOOLS_DIR: join(pluginRoot, 'third_party', 'harmony-tools', 'windows-x64'),
    DSH_HARMONY_NATIVE_VIDEO_DIR: join(pluginRoot, 'resources', 'native-video'),
    PI_CODING_AGENT_DIR: dataRoot,
    PIORA_RUNTIME_PROFILE: 'normal',
  };
}
