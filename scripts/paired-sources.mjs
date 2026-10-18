// dshHarmony's client build resolves the paired dshE2E log view, the shared
// search-history menu and the shared search rules straight from this source tree.
// A source package that ships only the two plugin entry points would fail to
// build, so the whole chain is part of the release contract.
import { readFile, lstat } from 'node:fs/promises';
import { join, dirname, resolve, isAbsolute } from 'node:path';

export const requiredPairedSources = [
  'LogWorkbench.jsx',
  'LogViewer.jsx',
  'LogTrash.jsx',
  'LogApplicationFilter.jsx',
  'LogSearchHistory.jsx',
  'SessionLogSearch.jsx',
  'log-client.mjs',
  'log-query.mjs',
  'log-search-menu.mjs',
  'presentation.mjs',
  'version.mjs',
  'client.css',
];

// Server-side modules that must ship with the source package. They are not part
// of the paired client build, but a package missing them cannot start or record.
export const requiredServerSources = [
  'index.mjs',
  'service.mjs',
  'agent.mjs',
  'tool-contract.mjs',
  'legacy.mjs',
  'snapshot.mjs',
  'validation-store.mjs',
  'validation-service.mjs',
  'capture-session.mjs',
  'logs.mjs',
  'evidence.mjs',
  'records.mjs',
];

const resolveExtensions = ['', '.mjs', '.jsx', '.js', '.json', '.css'];

async function exists(path) {
  try { await lstat(path); return true; } catch { return false; }
}

async function resolveImport(from, specifier) {
  const base = resolve(dirname(from), specifier);
  for (const extension of resolveExtensions) {
    const candidate = base + extension;
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Walk the real relative-import closure of `entry`. A new module imported by the
 * client must therefore appear in the package, otherwise this fails loudly
 * instead of at build time.
 */
export async function importClosure(root, entry = 'client.jsx') {
  const start = join(root, 'src', entry);
  const visited = new Set(), missing = [];
  async function visit(file) {
    if (visited.has(file)) return; visited.add(file);
    if (!(await exists(file))) { missing.push(file); return; }
    if (!/\.(mjs|js|jsx)$/.test(file)) return;
    const text = await readFile(file, 'utf8');
    const pattern = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g;
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1] || match[2];
      if (!specifier || !specifier.startsWith('.')) continue;
      const target = await resolveImport(file, specifier);
      if (!target) { missing.push(join(dirname(file), specifier)); continue; }
      if (isAbsolute(target) && !target.startsWith(root)) throw new Error(`import escapes the plugin source: ${specifier}`);
      await visit(target);
    }
  }
  await visit(start);
  if (missing.length) throw new Error(`dshE2E source import closure is incomplete: ${missing.map(file => file.replace(root + '\\', '').replace(root + '/', '')).join(', ')}`);
  return visited.size;
}

/**
 * Verify that every file the paired build needs is present in `root`.
 * Returns the number of verified files and throws with the complete list of
 * missing ones, so a truncated package fails loudly instead of at build time.
 */
export async function verifyPairedSources(root) {
  const missing = [];
  for (const file of requiredPairedSources) {
    try { await lstat(join(root, 'plugin', 'dsh-e2e', 'src', file)); }
    catch { missing.push(file); }
  }
  for (const file of requiredServerSources) {
    try { await lstat(join(root, 'plugin', 'dsh-e2e', 'src', file)); }
    catch { missing.push(file); }
  }
  for (const removed of ['engine.mjs', 'executor.mjs', 'rpc.mjs']) {
    if (await exists(join(root, 'plugin', 'dsh-e2e', 'src', removed))) throw new Error(`removed runner module is still present: plugin/dsh-e2e/src/${removed}`);
  }
  if (missing.length) {
    throw new Error(`dshE2E sources required by the paired build are missing: ${missing.map(file => `plugin/dsh-e2e/src/${file}`).join(', ')}`);
  }
  await importClosure(join(root, 'plugin', 'dsh-e2e'));
  return requiredPairedSources.length + requiredServerSources.length;
}
