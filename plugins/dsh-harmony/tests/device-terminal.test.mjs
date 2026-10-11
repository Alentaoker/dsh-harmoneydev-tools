import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

const moduleUrl = new URL(`./.terminal-test-${process.pid}.mjs`, import.meta.url);
const sourcePath = path.resolve('vendor/lib/harmony/device-terminal.ts');
const result = await build({
  stdin: { contents: (await readFile(sourcePath, 'utf8')) + '\nexport { DeviceTerminal };', resolveDir: path.dirname(sourcePath), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', write: false,
  plugins: [{ name: 'terminal-fixture', setup(builder) {
    builder.onResolve({ filter: /^(\.\.\/terminal-pty|\.\/index|\.\/device-files)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents:
      path === '../terminal-pty' ? 'export const loadTerminalPty=()=>({spawn:()=>globalThis.__dshHarmonyTerminalTest.child});' :
      path === './index' ? 'export const getHarmonyDeviceManager=()=>({getState:()=>({leases:[{token:"test-lease"}]})});' :
      'export const validateDeviceFilePath=()=>{};', loader: 'js' }));
  } }],
});
await writeFile(moduleUrl, result.outputFiles[0].contents);
const { DeviceTerminal } = await import(moduleUrl.href);
test.after(async () => { delete globalThis.__dshHarmonyTerminalTest; await unlink(moduleUrl); });
function fixture(writeFails = false) {
  const state = { writes: [], killed: false };
  const child = { onData: callback => { state.data = callback; }, onExit: callback => { state.exit = callback; },
    write: data => { if (writeFails) throw new Error('PTY exited during startup'); state.writes.push(data); },
    kill: () => { state.killed = true; }, resize() {} };
  globalThis.__dshHarmonyTerminalTest = { child };
  const terminal = new DeviceTerminal('test-phone', 'test-lease', { kind: 'shared' }, 'fixture-hdc', 'test-tab');
  return { terminal, state };
}
test('early device-shell input waits for the real prompt and flushes once', () => {
  const { terminal, state } = fixture();
  try {
    terminal.input('echo queued\r'); assert.deepEqual(state.writes, []);
    state.data('HDC initializing\r\n'); assert.deepEqual(state.writes, []);
    state.data('\x1b[32mphone:/ $ \x1b[0m'); assert.deepEqual(state.writes, ['echo queued\r']);
    state.data('\r\nphone:/ $ '); assert.equal(state.writes.length, 1);
    terminal.input('echo ready\r'); assert.equal(state.writes.length, 2);
  } finally { terminal.stop(); }
});
test('PTY disconnect during queued flush is contained and stops the terminal', () => {
  const { terminal, state } = fixture(true);
  try {
    terminal.input('echo queued\r');
    assert.doesNotThrow(() => state.data('phone:/ $ '));
    assert.equal(terminal.isConnected(), false); assert.equal(state.killed, true);
  } finally { terminal.stop(); }
});
