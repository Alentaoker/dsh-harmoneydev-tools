import path from 'node:path';
import { getHost } from './state';
import { getAdditionalAllowedRoots, normalizeSlashes } from '../vendor/lib/allowed-roots';
import { isExistingPathWithinRoots } from '../vendor/lib/path-security';
export { allowFileRoot, normalizeSlashes } from '../vendor/lib/allowed-roots';
export async function getAllowedFileRoots() {
  const roots = new Set<string>(getAdditionalAllowedRoots());
  for (const session of getHost().sessions.list()) {
    if (session.header.cwd) roots.add(normalizeSlashes(session.header.cwd));
  }
  return roots;
}
export function isWindowsAbsolutePath(p: string) { return /^[a-z]:[\\/]/i.test(p) || p.startsWith('\\\\') || p.startsWith('//'); }
export function isFilePathAllowed(target: string, roots: Set<string>) {
  return [...roots].some(root => {
    const api = isWindowsAbsolutePath(target) || isWindowsAbsolutePath(root) ? path.win32 : path;
    const relative = api.relative(api.resolve(root), api.resolve(target));
    return relative === '' || (relative !== '..' && !relative.startsWith('..' + api.sep) && !api.isAbsolute(relative));
  });
}
export const isExistingFilePathAllowed = isExistingPathWithinRoots;
