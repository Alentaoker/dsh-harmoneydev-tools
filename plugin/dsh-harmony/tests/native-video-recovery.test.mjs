import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const built=await build({stdin:{contents:"export * from './vendor/lib/harmony/native-video-recovery';export * from './vendor/lib/harmony/native-video-conflict';export * from './vendor/lib/harmony/request-error';",resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'node',packages:'external'});
const {releaseNativeVideoConflict,nativeVideoStartTime,nativeVideoConflictError,HarmonyRequestError}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
const expected={devicePid:51811,extension:'libscreen_casting.z.so',deviceStartTime:'22351072'};
const ps='shell 51811 1 0 00:58:07 ? 00:00:39 uitest start-daemon singleness --extension-name libscreen_casting.z.so';
const stat=t=>`51811 (xdevice scrcpy) S ${Array(18).fill('0').join(' ')} ${t} 0`;
test('process start time and actionable recovery survive the browser error boundary',()=>{
  assert.equal(nativeVideoStartTime(stat('22351072')),'22351072');
  assert.equal(nativeVideoStartTime('cat: Permission denied'),undefined);
  const error=nativeVideoConflictError([{source:'deveco',devicePid:51811,extension:expected.extension}],expected.deviceStartTime);
  const browser=new HarmonyRequestError(error.toJSON(),409);
  assert.deepEqual(browser.videoRecovery,expected);assert.match(browser.messageFor(true),/软件退出后也可能遗留/);
});
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'video-recovery-'));t.after(()=>rm(dir,{force:true,recursive:true}));return dir;}
test('recovery refuses a reused PID, changed process and DSH-owned extension without signalling',async t=>{
  const dir=await fixture(t),commands=[];
  const command=async(args,op)=>{commands.push(op);return op.endsWith('probe')?ps:stat('999');};
  await assert.rejects(releaseNativeVideoConflict('test',expected,command,undefined,dir),e=>e.code==='STALE_SNAPSHOT');
  await assert.rejects(releaseNativeVideoConflict('test',expected,async()=>'',undefined,dir),e=>e.code==='STALE_SNAPSHOT');
  await assert.rejects(releaseNativeVideoConflict('test',{...expected,extension:'libdsh_video_abc.so'},command,undefined,dir),e=>e.code==='INVALID_ARGUMENT');
  await assert.rejects(releaseNativeVideoConflict('test',{...expected,deviceStartTime:'1;killall uitest'},command,undefined,dir),e=>e.code==='INVALID_ARGUMENT');
  assert.equal(commands.includes('native_video_recovery_signal'),false);
});
test('explicit recovery stops only the verified external PID then verifies its disappearance',async t=>{
  const dir=await fixture(t),commands=[];let stopped=false;
  await releaseNativeVideoConflict('test',expected,async(args,op)=>{
    commands.push(args);
    if(op==='native_video_recovery_probe')return ps;
    if(op==='native_video_recovery_identity')return stat(expected.deviceStartTime);
    if(op==='native_video_recovery_signal'){
      assert.match(args[1],/kill -15 51811/);assert.match(args[1],/22351072/);assert.match(args[1],/ --extension-name libscreen_casting.z.so /);
      assert.doesNotMatch(args[1],/killall|fport|rm -|\bawk\b|\btr\b/);stopped=true;return '__DSH_VIDEO_SIGNALLED__';
    }
    if(op==='native_video_recovery_verify')return stopped?'':ps;
    throw Error(op);
  },undefined,dir);
  assert.equal(stopped,true);assert.equal(commands.filter(a=>a[1]?.includes('kill ')).length,1);
});
test('a denied normal signal uses an identity-checked force release; a denied force signal is not reported as PID reuse',async t=>{
  const dir=await fixture(t);let forced=false,stopped=false;
  const command=async(args,op)=>{
    if(op==='native_video_recovery_probe')return ps;
    if(op==='native_video_recovery_identity')return stat(expected.deviceStartTime);
    if(op==='native_video_recovery_verify')return stopped?'':ps;
    if(op==='native_video_recovery_signal'){
      if(!args[1].includes('kill -9'))return '__DSH_VIDEO_SIGNAL_DENIED__';
      forced=true;stopped=true;return '__DSH_VIDEO_SIGNALLED__';
    }
    throw Error(op);
  };
  await releaseNativeVideoConflict('test',expected,command,undefined,dir);assert.equal(forced,true);
  await assert.rejects(releaseNativeVideoConflict('denied',expected,async(args,op)=>op==='native_video_recovery_probe'||op==='native_video_recovery_verify'?ps:
    op==='native_video_recovery_identity'?stat(expected.deviceStartTime):'__DSH_VIDEO_SIGNAL_DENIED__',undefined,dir),
    e=>e.code==='CAPABILITY_UNAVAILABLE'&&e.details?.reason==='native-video-release-denied');
});
