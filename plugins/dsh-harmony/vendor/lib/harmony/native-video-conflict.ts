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

export function nativeVideoConflictError(conflicts: NativeVideoConflict[]): HarmonyError {
  const first = conflicts[0];
  const owner = first.source === 'deveco' ? 'DevEco'
    : first.source === 'dsh-untracked' ? '未登记的 DSH' : '其他软件';
  return new HarmonyError('DEVICE_BUSY', `设备上的${owner}投屏进程正在占用视频通道（设备 PID ${first.devicePid}）。请关闭该软件的设备投屏；释放后本页会自动重连，也可点击“重试实时视频”。`, {
    retryable: true,
    details: { reason: 'native-video-conflict', source: first.source, devicePid: first.devicePid,
      conflicts, recovery: 'wait-for-release' },
  });
}
