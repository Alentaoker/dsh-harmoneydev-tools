import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HarmonyError } from './errors';
import { nativeVideoConflicts, nativeVideoStartTime, type NativeVideoRecovery } from './native-video-conflict';
import { acquireDeviceLock, sharedDeviceLockDirectory } from './runtime/device-lock';

type Command = (args:string[], operation:string, signal?:AbortSignal)=>Promise<string>;
/** Explicit manual recovery only. Never called by connection/retry or AI tools. */
export async function releaseNativeVideoConflict(serial:string, expected:NativeVideoRecovery, command:Command, signal?:AbortSignal,
  directory=dirname(sharedDeviceLockDirectory())) {
  if (!expected || !Number.isSafeInteger(expected.devicePid) || expected.devicePid<1
    || !/^lib(?:screen_casting|scrcpy)[A-Za-z0-9_.-]*\.so$/.test(expected.extension)
    || !/^\d{1,20}$/.test(expected.deviceStartTime)) throw new HarmonyError('INVALID_ARGUMENT','Invalid external video process identity');
  const lock=acquireDeviceLock(serial,join(directory,'native-video'));
  let runtimeLock:ReturnType<typeof acquireDeviceLock>|undefined;
  try {
    runtimeLock=acquireDeviceLock(serial,join(directory,'runtime-init'));
    const ps=await command(['shell','ps -ef'],'native_video_recovery_probe',signal);
    const same=nativeVideoConflicts(ps).some(c=>c.devicePid===expected.devicePid&&c.extension===expected.extension&&c.source!=='dsh-untracked');
    if(!same)throw new HarmonyError('STALE_SNAPSHOT','投屏进程已变化，请重试视频后重新确认，未停止任何进程。');
    const stat=await command(['shell',`cat /proc/${expected.devicePid}/stat`],'native_video_recovery_identity',signal);
    if(nativeVideoStartTime(stat)!==expected.deviceStartTime)throw new HarmonyError('STALE_SNAPSHOT','设备 PID 已被复用，未停止任何进程。请重新检查。');
    // Recheck kernel start time and the verified argv identity in one dispatch.
    // No killall, prefix matching, host-process termination, or foreign file deletion.
    const dispatch=async (force:boolean)=>{
      const {devicePid:p,deviceStartTime:t,extension:e}=expected;
      // Retail HarmonyOS may have no awk/tr. Parse stat with shell builtins;
      // the process name in parentheses can itself contain whitespace or ')'.
      const script=`s=$(cat /proc/${p}/stat 2>/dev/null); s=\${s##*) }; set -- $s; if [ "$#" -ge 20 ]; then shift 19; t=$1; else t=; fi; c=$(ps -p ${p} -o ARGS=); if [ "$t" = '${t}' ] && printf ' %s ' "$c" | grep -Fq -- ' --extension-name ${e} ' && grep -aFq '/system/bin/uitest' /proc/${p}/cmdline; then if kill ${force?'-9':'-15'} ${p}; then printf '__DSH_VIDEO_SIGNALLED__'; else printf '__DSH_VIDEO_SIGNAL_DENIED__'; fi; else printf '__DSH_VIDEO_CHANGED__'; fi`;
      const result=await command(['shell',script],'native_video_recovery_signal',signal);
      if(result.includes('__DSH_VIDEO_SIGNAL_DENIED__')){
        if(!force)return false;
        throw new HarmonyError('CAPABILITY_UNAVAILABLE','设备拒绝释放此投屏进程。请在原软件停止投屏；若原软件已经退出，需重新连接该软件后停止，或重启手机。',{details:{reason:'native-video-release-denied'}});
      }
      if(!result.includes('__DSH_VIDEO_SIGNALLED__'))throw new HarmonyError('STALE_SNAPSHOT','投屏进程身份已变化，未发送停止命令。');
      return true;
    };
    const graceful=await dispatch(false);
    const remaining=async()=>nativeVideoConflicts(await command(['shell','ps -ef'],'native_video_recovery_verify')).some(c=>c.devicePid===expected.devicePid&&c.extension===expected.extension);
    for(let i=0;i<(graceful?4:1);i++){if(!await remaining())return;if(graceful)await delay(150);}
    await dispatch(true);
    if(await remaining())throw new HarmonyError('DEVICE_BUSY','投屏进程仍未退出，请检查设备连接。');
  } finally {runtimeLock?.release();lock.release();}
}
