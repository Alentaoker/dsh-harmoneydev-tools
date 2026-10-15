// Optional local benchmark: Node 24 --expose-gc scripts/benchmark-logs.mjs [MiB] [result.json]
// Uses generated diagnostic text, isolated temporary storage, and no phone/model.
import { mkdtemp, writeFile, appendFile, stat, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogLibrary } from '../plugin/dsh-e2e/src/log-library.mjs';
const mib = Math.max(33, Math.min(256, Number(process.argv[2]) || 64)), root = await mkdtemp(join(tmpdir(), 'dsh-log-bench-')), file = join(root, 'generated.log');
const scope = { sessionId: 'benchmark-isolated' }, library = createLogLibrary(join(root, 'data')); let timer;
try {
  await writeFile(file, ''); let bytes = 0, count = 0;
  while (bytes < mib * 1024 * 1024) { let batch = ''; for (let i = 0; i < 512; i++) { batch += `10-16 00:01:02.003 11 12 I C00123/${count % 2 ? 'test.app' : 'other.app'}/Work: ${count++} ${'x'.repeat(180)}\n`; } await appendFile(file, batch); bytes += Buffer.byteLength(batch); }
  globalThis.gc?.(); const baselineRSS = process.memoryUsage().rss; let peakRSS = baselineRSS, peakHeap = process.memoryUsage().heapUsed;
  timer = setInterval(() => { const m = process.memoryUsage(); peakRSS = Math.max(peakRSS, m.rss); peakHeap = Math.max(peakHeap, m.heapUsed); }, 10);
  const began = performance.now(), started = await library.begin({ name: 'generated.log', size: (await stat(file)).size }, scope);
  let chunk = 0; for await (const data of createReadStream(file, { highWaterMark: 262144 })) await library.chunk(started.id, chunk++, data, scope);
  const value = await library.finish(started.id, scope), importMs = performance.now() - began;
  const timing = async options => { const start = performance.now(), page = await library.getLogs(value.id, options, scope); return { ms: performance.now() - start, lines: page.entries.length, matched: page.filteredTotal, responseBytes: Buffer.byteLength(JSON.stringify(page)), firstSourceLine: page.entries[0]?.sourceLine }; };
  const first = await timing({ limit: 1000 }), tail = await timing({ limit: 1000, offset: count - 1000 }), filterFirst = await timing({ limit: 1000, bundle: 'test.app' }), filterNext = await timing({ limit: 1000, bundle: 'test.app', offset: 1000 });
  clearInterval(timer); timer = undefined; globalThis.gc?.();
  const result = { scope: 'generated text; isolated backend; no browser, phone or model', inputBytes: bytes, count, imported: value.count, storedBytes: value.storedBytes, compressionRatio: value.storedBytes / bytes, importMs, first, tail, filterFirst, filterNext, baselineRSS, peakRSS, incrementalPeakRSS: peakRSS - baselineRSS, peakMainHeap: peakHeap, finalRSS: process.memoryUsage().rss };
  if (value.count !== count || first.lines !== 1000 || tail.firstSourceLine !== count - 999 || filterNext.matched !== Math.floor(count / 2)) throw Error('Benchmark correctness check failed');
  if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally { clearInterval(timer); await library.dispose(); await rm(root, { recursive: true, force: true }); }
