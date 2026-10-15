import { HarmonyError } from './errors';

export interface NativeVideoConflict {
  source: 'deveco' | 'dsh-untracked' | 'other';
  devicePid: number;
  extension: string;
}

/** Match the daemon itself, never a shell/grep whose command mentions uitest. */
export function nativeVideoConflicts(output: string): NativeVideoConflict[] {
  const conflicts: NativeVideoConflict[] = [];
  for (const line of output.split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (!/^\d+$/.test(columns[1] ?? '') || !/(?:^|\/)uitest$/.test(columns[7] ?? '')) continue;
    const index = columns.indexOf('--extension-name', 8);
    const extension = (columns[index + 1] ?? '').split('/').at(-1) ?? '';
    if (index < 0 || !/^(?:libscreen_casting|libscrcpy|libdsh_video_)[A-Za-z0-9_.-]*\.so$/.test(extension)) continue;
    const devicePid = Number(columns[1]);
    if (!Number.isSafeInteger(devicePid) || devicePid < 1) continue;
    conflicts.push({ devicePid, extension, source: extension.startsWith('libdsh_video_') ? 'dsh-untracked'
      : extension.startsWith('libscreen_casting') ? 'deveco' : 'other' });
    if (conflicts.length === 8) break;
  }
  return conflicts;
}

export interface NativeVideoRecovery { devicePid: number; extension: string; deviceStartTime: string }
export function nativeVideoStartTime(stat: string): string | undefined {
  const tail = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  return stat.includes(')') && /^\d{1,20}$/.test(tail[19] ?? '') ? tail[19] : undefined;
}
export function nativeVideoConflictError(conflicts: NativeVideoConflict[], deviceStartTime?: string): HarmonyError {
  const first = conflicts[0];
  const owner = first.source === 'deveco' ? 'DevEco'
    : first.source === 'dsh-untracked' ? '未登记的 DSH' : '其他软件';
  return new HarmonyError('DEVICE_BUSY', `手机上仍有${owner}来源的投屏进程（设备 PID ${first.devicePid}），电脑软件退出后也可能遗留。请先关闭其投屏；确认不再使用时，可释放占用并重连。`, {
    retryable: true,
    details: { reason: 'native-video-conflict', source: first.source, devicePid: first.devicePid,
      ...(deviceStartTime && first.source !== 'dsh-untracked' ? {deviceStartTime, extension:first.extension} : {}),
      conflicts, recovery: 'wait-for-release' },
  });
}
