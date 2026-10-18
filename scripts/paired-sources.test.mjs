import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { requiredPairedSources, requiredServerSources, verifyPairedSources } from './paired-sources.mjs';

const repository = resolve(import.meta.dirname, '..');
const contract = [...requiredPairedSources, ...requiredServerSources];

async function stage(files) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-paired-'));
  for (const file of files) {
    const path = join(root, 'plugin', 'dsh-e2e', 'src', file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '// staged\n');
  }
  return root;
}

test('the real repository satisfies the paired build contract and its import closure', async () => {
  assert.equal(await verifyPairedSources(repository), contract.length);
});

test('a truncated package fails and names every missing file', async () => {
  const root = await stage(contract.filter(file => file !== 'LogSearchHistory.jsx' && file !== 'validation-store.mjs'));
  try {
    await assert.rejects(verifyPairedSources(root), error => {
      assert.match(error.message, /plugin\/dsh-e2e\/src\/LogSearchHistory\.jsx/);
      assert.match(error.message, /plugin\/dsh-e2e\/src\/validation-store\.mjs/);
      assert.doesNotMatch(error.message, /LogWorkbench\.jsx/, 'present files are not reported');
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a package that still ships the removed runner modules is rejected', async () => {
  const root = await stage(contract);
  try {
    await writeFile(join(root, 'plugin', 'dsh-e2e', 'src', 'engine.mjs'), '// stale runner\n');
    await assert.rejects(verifyPairedSources(root), /removed runner module is still present: plugin\/dsh-e2e\/src\/engine\.mjs/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the paired list covers the whole import chain of the paired view', async () => {
  // Derive the real chain instead of trusting a hand-written list: start at the
  // modules the paired build resolves and follow every relative import.
  const seen = new Set();
  const pending = ['LogWorkbench.jsx', 'log-search-menu.mjs', 'client.css'];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file) || file.startsWith('..')) continue;
    seen.add(file);
    if (!/\.(?:jsx?|mjs|css)$/.test(file)) continue;
    const text = await readFile(join(repository, 'plugin', 'dsh-e2e', 'src', file), 'utf8');
    for (const [, specifier] of text.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)) {
      pending.push(specifier.replace(/^\.\//, ''));
    }
  }
  const missing = [...seen].filter(file => !requiredPairedSources.includes(file));
  assert.deepEqual(missing, [], 'every module the paired build resolves must be verified by preflight');
});
