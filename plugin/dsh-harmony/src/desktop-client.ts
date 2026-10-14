async function call(action: string, data: any = {}) {
  const response = await fetch('/api/harmony/desktop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...data }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Desktop action failed');
  return result.result;
}
/** Local bridge used only by the vendored Harmony components. */
export const harmonyDesktop = {
  platform: 'win32',
  selectHarmonyRuntimePath: (kind: string) => call('choose-runtime', { kind }),
  openPath: (path: string) => call('open-media', { path }),
  files: { getPathForFile: (file: File) => (window as any).__DSH_HOST_PATHS__?.pathFor(file) || (file as any).path || '' },
  clipboard: {
    readText: () => call('clipboard-read'),
    writeText: (text: string) => call('clipboard-write', { text }),
    copyHarmonyMedia: (data: any) => call('copy-media', data),
  },
};
