/** Parse only documented WindowManagerService fields; never infer an app from its label. */
export function focusedWindowId(dump: string): string | undefined {
  const matches = [...dump.matchAll(/^\s*Focus window:\s*(\d+)\s*$/gm)];
  return matches.length === 1 ? matches[0][1] : undefined;
}
export function windowBundle(dump: string, windowId: string): string | undefined {
  const id = dump.match(/^\s*WinId:\s*(\d+)\s*$/m)?.[1];
  const bundles = [...dump.matchAll(/^\s*bundleName:\s*([A-Za-z][A-Za-z0-9_.]{0,255})\s*$/gm)];
  return id === windowId && bundles.length === 1 ? bundles[0][1] : undefined;
}
