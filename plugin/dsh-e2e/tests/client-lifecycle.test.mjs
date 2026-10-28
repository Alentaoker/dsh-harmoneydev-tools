import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const tick = () => new Promise(resolve => setImmediate(resolve));
const bundles = new Map();
async function sourceBundle(viewer) {
  const key = viewer === 'library' ? 'LogWorkbench.jsx' : viewer ? 'LogViewer.jsx' : 'client.jsx';
  if (!bundles.has(key)) bundles.set(key, build({ entryPoints: [fileURLToPath(new URL('../src/' + key, import.meta.url))], bundle: true,
    format: 'cjs', platform: 'browser', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], loader: { '.css': 'empty' }, write: false }).then(result => result.outputFiles[0].text));
  return bundles.get(key);
}
async function harness(viewer = false) {
  const state = [], effects = [], queue = [], requests = [], timers = new Map(); let cursor = 0, timerId = 0, Panel, exports, dirty = false;
  const jsx = (type, props) => ({ type, props });
  const react = {
    useRef(initial) { const i = cursor++; if (!(i in state)) state[i] = { current: initial }; return state[i]; },
    useMemo(fn) { cursor++; return fn(); },
    useState(initial) { const i = cursor++; if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial; return [state[i], value => { const next = typeof value === 'function' ? value(state[i]) : value; dirty ||= !Object.is(state[i], next); state[i] = next; }]; },
    useEffect(fn, deps) { const i = cursor++, previous = effects[i]; if (!previous || !deps || deps.some((v, j) => !Object.is(v, previous.deps[j]))) queue.push(() => { previous?.cleanup?.(); effects[i] = { deps, cleanup: fn() }; }); },
  };
  const context = {
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} }, window: { addEventListener() {}, removeEventListener() {} },
    document: { getElementById: () => ({}), head: { appendChild() {} }, addEventListener() {}, removeEventListener() {} }, AbortController, URLSearchParams, Date, Number, String, JSON, URL,
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
    fetch(url, options = {}) { return new Promise(resolve => requests.push({ url, signal: options.signal, resolve })); },
  };
  const module = { exports: {} };
  runInNewContext(await sourceBundle(viewer), { ...context, module, exports: module.exports, require: name => name === 'react' ? react : { jsx, jsxs: jsx } });
  exports = module.exports;
  if (viewer) Panel = viewer === 'library' ? exports.LogWorkbench : exports.LogViewer;
  const ctx = { effect: fn => fn(), sidebarRightTabs: { register() {} }, slots: { inject: (_name, fn) => fn(), register: (slot, component) => { if (slot.name === 'sidebar.right.pane.tab') Panel = component; } }, sessions: { scope: id => ({ id }) }, conversation: { input: { for: () => ({ setDraft() {} }) } } };
  if (!viewer) exports.apply(ctx);
  const render = (sessionId, visible) => {
    let tree, count = 0;
    do { dirty = false; cursor = 0; tree = Panel(viewer === 'library' ? { sessionId, visible, onDraft() {} } : viewer ? { url: '/logs?id=test', visible } : { sessionId, useTabInfo: () => ({ tab: { visible } }) }); while (queue.length) queue.shift()(); if (++count > 25) throw Error('Non-settling client effects'); } while (dirty);
    return tree;
  };
  const reply = (request, value) => request.resolve(new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }));
  const text = tree => { if (tree == null || typeof tree === 'boolean') return ''; if (typeof tree !== 'object') return String(tree); if (Array.isArray(tree)) return tree.map(text).join(' '); return text(tree.props?.children); };
  const find = (tree, predicate) => { if (!tree || typeof tree !== 'object') return; if (Array.isArray(tree)) { for (const child of tree) { const result = find(child, predicate); if (result) return result; } return; } if (predicate(tree)) return tree; return find(tree.props?.children, predicate); };
  const button = (tree, label) => { const value = find(tree, node => node.type === 'button' && text(node) === label); assert.ok(value, 'Missing button: ' + label); return value; };
  const openValidation = (sessionId, visible = true) => { const tree = render(sessionId, visible); assert.ok(find(tree, node => node.type === 'summary' && text(node) === '更多工具')); button(tree, '开发验证').props.onClick(); return render(sessionId, visible); };
  return { render, reply, requests, timers, text, button, openValidation, dispose() { for (const effect of effects) effect?.cleanup?.(); } };
}

test('dshVerify 默认日志工作台不读取手机状态或验证记录，开发验证收在更多工具', async () => {
  const h = await harness(); try {
    const hidden = h.render('A', false); assert.equal(h.requests.length, 0); assert.match(h.text(hidden), /会话日志/);
    const visible = h.render('A', true); assert.equal(h.requests.length, 0); assert.match(h.text(visible), /dshVerify/);
    h.openValidation('A'); assert.equal(h.requests.length, 2); assert.ok(h.requests.some(request => request.url.includes('/status?'))); assert.ok(h.requests.some(request => request.url.includes('/runs?')));
  } finally { h.dispose(); }
});

test('开发验证隐藏时不开请求，显示后读取，隐藏取消在途请求及轮询并拒收迟到响应', async () => {
  const h = await harness(); try {
    h.openValidation('first', false); assert.equal(h.requests.length, 0);
    h.render('first', true); assert.equal(h.requests.length, 2); const pending = [...h.requests];
    h.render('first', false); assert.ok(pending.every(request => request.signal.aborted));
    for (const request of pending) h.reply(request, request.url.includes('/status') ? { active: [] } : { runs: [{ id: 'foreign', name: '迟到的旧记录' }], counts: {}, filteredTotal: 1, nextOffset: null }); await tick();
    assert.equal(h.text(h.render('first', false)).includes('迟到的旧记录'), false); assert.equal([...h.timers.values()].some(timer => timer.ms === 15000), false);
    h.render('first', true); assert.equal(h.requests.length, 4);
  } finally { h.dispose(); }
});

test('开发验证切会话取消旧读取且回到默认日志，旧响应不能覆盖新会话记录', async () => {
  const h = await harness(); try {
    h.openValidation('first'); const old = [...h.requests];
    const switched = h.render('second', true); assert.ok(old.every(request => request.signal.aborted)); assert.match(h.text(switched), /会话日志/);
    const before = h.requests.length; h.openValidation('second'); const current = h.requests.slice(before); assert.equal(current.length, 2); assert.ok(current.every(request => request.url.includes('sessionId=second')));
    for (const request of current) h.reply(request, request.url.includes('/status') ? { active: [], devices: [] } : { runs: [{ id: 'new', name: '新会话报告', status: 'passed' }], counts: { all: 1, passed: 1 }, filteredTotal: 1, nextOffset: null, offset: 0 }); await tick();
    for (const request of old) h.reply(request, request.url.includes('/status') ? { active: [] } : { runs: [{ id: 'old', name: '旧会话报告' }], counts: { all: 1 }, filteredTotal: 1, nextOffset: null }); await tick();
    const text = h.text(h.render('second', true)); assert.equal(text.includes('新会话报告'), true); assert.equal(text.includes('旧会话报告'), false);
  } finally { h.dispose(); }
});

test('日志页被正文大小缩短后，上一页回到真实起点，不固定减去 100', async () => {
  const h = await harness(true); try {
    h.render('one', true); h.reply(h.requests.at(-1), { total: 210, filteredTotal: 210, offset: 0, entries: [], nextOffset: 69 }); await tick();
    h.button(h.render('one', true), '下一页').props.onClick(); h.render('one', true); assert.ok(h.requests.at(-1).url.includes('offset=69')); h.reply(h.requests.at(-1), { total: 210, filteredTotal: 210, offset: 69, entries: [], nextOffset: 140 }); await tick();
    h.button(h.render('one', true), '下一页').props.onClick(); h.render('one', true); assert.ok(h.requests.at(-1).url.includes('offset=140')); h.reply(h.requests.at(-1), { total: 210, filteredTotal: 210, offset: 140, entries: [], nextOffset: 200 }); await tick();
    h.button(h.render('one', true), '上一页').props.onClick(); h.render('one', true); assert.ok(h.requests.at(-1).url.includes('offset=69'));
  } finally { h.dispose(); }
});

test('日志工作台切换会话后取消旧读取，迟到文件不会串入新会话', async () => {
  const h = await harness('library'); try {
    h.render('A', true); const old = h.requests.find(request => request.url.includes('/list?')); h.render('B', true); assert.equal(old.signal.aborted, true); const current = h.requests.find(request => request.url.includes('/list?') && request.url.includes('sessionId=B'));
    h.reply(current, { protocolVersion: 2, sessionId: 'B', files: [{ id: 'b', sessionId: 'B', name: 'B独有.log', size: 12, count: 1 }], total: 1, nextOffset: null }); await tick();
    h.reply(old, { protocolVersion: 2, sessionId: 'A', files: [{ id: 'a', sessionId: 'A', name: 'A独有.log' }], total: 1, nextOffset: null }); await tick();
    const value = h.text(h.render('B', true)); assert.ok(value.includes('B独有.log')); assert.ok(!value.includes('A独有.log'));
    h.render('B', false); assert.equal(current.signal.aborted, true);
  } finally { h.dispose(); }
});

test('开发验证返回日志工作台取消轮询，不再访问手机状态', async () => {
  const h = await harness(); try {
    h.openValidation('A'); assert.equal(h.requests.length, 2); h.button(h.render('A', true), '日志工作台').props.onClick(); const next = h.render('A', true);
    assert.equal(h.requests.length, 2); assert.ok(h.requests.every(request => request.signal.aborted)); assert.match(h.text(next), /会话日志/);
  } finally { h.dispose(); }
});

test('工作台拦截文件拖入冒泡，文本拖动保持原生，不交给宿主附件入口', async () => {
  const h = await harness('library'); try {
    const root = h.render('A', true); let stopped = 0, prevented = 0;
    const files = { dataTransfer: { types: ['Files'], dropEffect: 'none', files: [] }, preventDefault() { prevented++; }, stopPropagation() { stopped++; } };
    root.props.onDragEnter(files); root.props.onDragOver(files); root.props.onDrop(files); assert.equal(stopped, 3); assert.equal(prevented, 3);
    const text = { ...files, dataTransfer: { types: ['text/plain'] } }; root.props.onDragEnter(text); root.props.onDragOver(text); root.props.onDrop(text); assert.equal(stopped, 3);
  } finally { h.dispose(); }
});
