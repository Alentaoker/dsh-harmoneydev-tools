import { HarmonyError } from './errors';

export function nativeVideoLoaderFailure(log: string): HarmonyError | undefined {
  if (/symbol not found|relocating failed|cannot locate symbol/i.test(log)) {
    const symbol = log.match(/(?:s=|symbol not found[:\s]+|cannot locate symbol\s+["']?)([_A-Za-z][_A-Za-z0-9:.]{0,500})/i)?.[1];
    return new HarmonyError('CAPABILITY_UNAVAILABLE', '设备原生投屏组件的系统接口不兼容，已保留兼容投屏。请更新匹配的原厂组件。',
      { details: { reason: 'native-video-loader-abi-incompatible', ...(symbol ? { symbol } : {}) } });
  }
  if (/xpm check failed|failed to map header|permission denied/i.test(log)) {
    return new HarmonyError('CAPABILITY_UNAVAILABLE', '设备拒绝加载原生投屏组件，请使用系统允许的完整原厂组件；可继续使用兼容投屏。',
      { details: { reason: 'native-video-loader-integrity-rejected' } });
  }
}

// Loader errors are permanent for this binary. Do not wait out the RPC timeout
// or treat them as a transient disconnect that merits another identical start.
export async function waitForNativeVideoReady(client: any, probe: () => Promise<string>, signal?: AbortSignal) {
  let done = false, timer: ReturnType<typeof setTimeout> | undefined, polling: Promise<void> = Promise.resolve();
  let abort: () => void = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { if (done) return; done = true; error ? reject(error) : resolve(); };
      abort = () => finish(new HarmonyError('COMMAND_ABORTED', 'Video start cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) return abort();
      const poll = () => {
        if (done) return;
        polling = probe().then(log => { if (!done) { const error = nativeVideoLoaderFailure(log); if (error) finish(error); } })
          .catch(() => { if (signal?.aborted) abort(); })
          .finally(() => { if (!done) timer = setTimeout(poll, 400); });
      };
      try { client.waitForReady(Date.now() + 12000, (error?: Error) => finish(error)); }
      catch (error) { finish(error as Error); }
      if (!done) timer = setTimeout(poll, 250);
    });
  } finally { done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); await polling; }
}
