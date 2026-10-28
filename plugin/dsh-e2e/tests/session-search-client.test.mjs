import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const tick = () => new Promise(resolve => setImmediate(resolve));
const bundled = build({ entryPoints: [fileURLToPath(new URL('../src/SessionLogSearch.jsx', import.meta.url))], bundle: true,
  format: 'cjs', platform: 'browser', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], write: false }).then(result => result.outputFiles[0].text);
const plain = value => JSON.parse(JSON.stringify(value));
function keyboard(key, extra = {}) {
  return { key, ctrlKey: false, metaKey: false, shiftKey: false, defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
}
async function harness() {
  const state = [], effects = [], queue = [], requests = [], opens = [], listeners = new Map(), storage = new Map(), clipboard = [];
  let cursor = 0, dirty = false, tree, ensured = 0, focused = '', scrolls = 0, currentSession = 'A', currentVisible = true;
  const document = { activeElement: undefined }, workspace = { contains: element => !!element?.owned };
  const nodeFor = (type, props) => ({ type, props, owned: true,
    focus() { document.activeElement = this; focused = props['aria-label'] || props.className || type; }, select() {},
    closest(selector) { if (selector === '.log-library') return workspace; return ['button', 'input', 'select', 'textarea', 'summary', 'a'].includes(type) ? this : null; },
    contains(element) { return element === this; }, querySelector() { return { scrollIntoView() { scrolls++; } }; },
  });
  const jsx = (type, props) => { if (typeof type === 'string' && props?.ref && typeof props.ref === 'object') props.ref.current = nodeFor(type, props); return { type, props }; };
  const react = {
    useRef(initial) { const i = cursor++; if (!(i in state)) state[i] = { current: initial }; return state[i]; },
    useState(initial) { const i = cursor++; if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial; return [state[i], value => { const next = typeof value === 'function' ? value(state[i]) : value; dirty ||= !Object.is(state[i], next); state[i] = next; }]; },
    useEffect(fn, deps) { const i = cursor++, previous = effects[i]; if (!previous || !deps || deps.some((value, index) => !Object.is(value, previous.deps[index]))) queue.push(() => { previous?.cleanup?.(); effects[i] = { deps, cleanup: fn() }; }); },
  };
  const context = { AbortController, URLSearchParams, Date, Number, String, JSON, URL, TextEncoder, document,
    sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    navigator: { clipboard: { async writeText(value) { clipboard.push(value); } } }, requestAnimationFrame: callback => callback(),
    window: { addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); }, removeEventListener(name, fn) { listeners.get(name)?.delete(fn); } },
    fetch(url, options = {}) { return new Promise(resolve => requests.push({ url, signal: options.signal, resolve })); },
  };
  const module = { exports: {} }; runInNewContext(await bundled, { ...context, module, exports: module.exports, require: name => name === 'react' ? react : { jsx, jsxs: jsx } });
  const open = (...args) => opens.push(plain(args)), ensure = () => { ensured++; };
  const render = (sessionId = currentSession, visible = currentVisible) => {
    currentSession = sessionId; currentVisible = visible;
    let iterations = 0;
    do { dirty = false; cursor = 0; tree = module.exports.SessionLogSearch({ sessionId, visible, onOpenSource: open, onEnsureVisible: ensure }); while (queue.length) queue.shift()(); if (++iterations > 25) throw Error('Non-settling session search effects'); } while (dirty);
    return tree;
  };
  const all = (node, predicate, found = []) => {
    if (!node || typeof node !== 'object') return found;
    if (Array.isArray(node)) { node.forEach(child => all(child, predicate, found)); return found; }
    if (predicate(node)) found.push(node); all(node.props?.children, predicate, found); return found;
  };
  const text = node => { if (node == null || typeof node === 'boolean') return ''; if (typeof node !== 'object') return String(node); if (Array.isArray(node)) return node.map(text).join(' '); return text(node.props?.children); };
  const find = predicate => { const node = all(tree, predicate)[0]; assert.ok(node, 'Missing node'); return node; };
  const button = label => find(node => node.type === 'button' && text(node) === label);
  const input = () => find(node => node.type === 'input' && node.props['aria-label'] === '跨文件查找目标');
  const rows = () => all(tree, node => node.props?.className?.split(' ').includes('session-search-hit'));
  const batches = () => all(tree, node => node.props?.role === 'treeitem' && node.props['aria-level'] === 1);
  const reply = async (request, value) => { request.resolve(new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })); await tick(); await tick(); };
  const start = query => { input().props.onChange({ target: { value: query } }); render(); find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); render(); return requests.at(-1); };
  const globalKey = (key, extra = {}) => { const event = keyboard(key, extra); for (const listener of [...listeners.get('keydown') || []]) listener(event); return event; };
  return { render, all: predicate => all(tree, predicate), text: () => text(tree), find, button, input, rows, batches, reply, start, requests, opens, storage, clipboard, globalKey,
    get ensured() { return ensured; }, get focused() { return focused; }, get scrolls() { return scrolls; }, get tree() { return tree; },
    dispose() { for (const effect of effects) effect?.cleanup?.(); } };
}
const match = (line, occurrenceIndex = 0, column = 1) => ({ fileId: 'f1', fileName: 'phone.log', sourceLine: line, message: line === 1 ? 'ERROR + ERROR' : 'ERROR next',
  messageTruncated: false, ranges: [[column - 1, column + 4]], hitCount: line === 1 ? 2 : 1, occurrenceIndex, column });
const page = (sessionId = 'A', options = {}) => ({ sessionId, searchedFiles: 1, matchedFiles: 1, filteredTotal: 2, totalHits: 3, resultTotal: 3,
  searchRevision: 'rev-1', fileMatches: [{ id: 'f1', name: 'phone.log', count: 2, hits: 3 }], errors: [], entries: [match(1), match(1, 1, 9)], offset: 0, nextOffset: 2, ...options });

test('跨文件默认每次出现一条，参数、服务端高亮、双击原文列范围与保留结果均按实际交互生效', async () => {
  const h = await harness(); try {
    h.render(); const pending = h.start('ERROR'); const params = new URL(pending.url, 'http://localhost').searchParams;
    assert.equal(params.get('mode'), 'normal'); assert.equal(params.get('oneEntryPerLine'), 'false'); assert.equal(params.get('sessionId'), 'A');
    await h.reply(pending, page()); h.render(); assert.equal(h.batches().length, 1); assert.equal(h.rows().length, 2); assert.match(h.text(), /匹配 3 次，2 行/);
    const marks = h.all(node => node.type === 'mark'); assert.deepEqual(marks.map(node => node.props.children), ['ERROR', 'ERROR']);
    h.rows()[1].props.onClick(); h.render(); h.rows()[1].props.onDoubleClick(); h.render();
    assert.deepEqual(h.opens.at(-1), ['f1', 1, { column: 9, ranges: [[8, 13]], occurrenceIndex: 1 }]);
    assert.equal(h.batches().length, 1); assert.equal(h.rows().length, 2); assert.equal(h.rows()[1].props['aria-selected'], true); assert.ok(h.scrolls > 0);
  } finally { h.dispose(); }
});

test('F4 跨真实短页加载下一命中，Shift+F4 不固定减100且翻页不创建新搜索批次', async () => {
  const h = await harness(); try {
    h.render(); await h.reply(h.start('ERROR'), page()); h.render();
    h.globalKey('F4'); h.render(); assert.equal(h.opens.at(-1)[2].column, 1);
    h.globalKey('F4'); h.render(); assert.equal(h.opens.at(-1)[2].column, 9);
    h.globalKey('F4'); h.render(); let pending = h.requests.at(-1); assert.equal(new URL(pending.url, 'http://localhost').searchParams.get('offset'), '2');
    await h.reply(pending, page('A', { offset: 2, entries: [match(2)], nextOffset: null })); h.render();
    assert.equal(h.opens.at(-1)[1], 2); assert.equal(h.batches().length, 1); assert.equal(h.rows().length, 1);
    h.globalKey('F4', { shiftKey: true }); h.render(); pending = h.requests.at(-1); assert.equal(new URL(pending.url, 'http://localhost').searchParams.get('offset'), '1');
    await h.reply(pending, page('A', { offset: 1, entries: [match(1, 1, 9), match(2)], nextOffset: null })); h.render();
    assert.equal(h.opens.at(-1)[2].column, 9); assert.equal(h.batches().length, 1);
    h.globalKey('F7'); assert.equal(h.focused, '跨文件查找结果，搜索轮次、文件、命中');
  } finally { h.dispose(); }
});

test('分页结果指纹改变时保留旧页并明确报错，不把已删除或变化的文件拼到旧批次', async () => {
  const h = await harness(); try {
    h.render(); await h.reply(h.start('ERROR'), page()); h.render(); h.button('下一页').props.onClick(); h.render();
    await h.reply(h.requests.at(-1), page('A', { searchRevision: 'rev-2', offset: 2, entries: [match(2)], nextOffset: null })); h.render();
    assert.equal(h.rows().length, 2); assert.match(h.text(), /日志文件或结果已发生变化/); assert.match(h.text(), /上一次已完成的结果页/);
  } finally { h.dispose(); }
});

test('输入法 Enter 和 Esc 不应用历史或触发查找，组合输入期间提交及F4均不执行', async () => {
  const h = await harness(); try {
    h.render(); h.input().props.onChange({ target: { value: 'ERROR' } }); h.render(); h.input().props.onCompositionStart();
    h.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); assert.equal(h.requests.length, 0);
    const enter = keyboard('Enter', { nativeEvent: { isComposing: true } }); h.input().props.onKeyDown(enter); assert.equal(enter.defaultPrevented, false);
    const escape = keyboard('Escape', { nativeEvent: { keyCode: 229 } }); h.tree.props.onKeyDown(escape); assert.equal(escape.stopped, false);
    const f4 = h.globalKey('F4', { isComposing: true }); assert.equal(f4.defaultPrevented, false); assert.equal(h.opens.length, 0);
    h.input().props.onCompositionEnd(); h.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); h.render(); assert.equal(h.requests.length, 1);
    await h.reply(h.requests[0], page()); h.render();
    h.button('▾').props.onClick(); h.render(); const historyEscape = keyboard('Escape'); h.tree.props.onKeyDown(historyEscape); h.render();
    assert.equal(historyEscape.defaultPrevented, true); assert.equal(historyEscape.stopped, true); assert.equal(h.all(node => node.props?.['aria-label'] === '跨文件完整条件历史').length, 0);
  } finally { h.dispose(); }
});

test('隐藏搜索视图中止读取且拒绝迟到响应，切会话时旧结果和完整条件历史不串会话', async () => {
  const h = await harness(); try {
    h.render(); const old = h.start('ERROR'); h.render('A', false); assert.equal(old.signal.aborted, true);
    await h.reply(old, page()); h.render('A', false); assert.equal(h.rows().length, 0); assert.match(h.text(), /视图已隐藏，搜索已停止/);
    h.render('B', true); assert.equal(h.batches().length, 0); const current = h.start('new'); assert.equal(new URL(current.url, 'http://localhost').searchParams.get('sessionId'), 'B');
  } finally { h.dispose(); }
});

test('搜索批次最多5批，新批展开旧批折叠；清空结果不发任何删除请求', async () => {
  const h = await harness(); try {
    h.render(); for (let i = 0; i < 6; i++) { await h.reply(h.start('q' + i), page('A', { entries: [match(1)], nextOffset: null })); h.render(); }
    assert.equal(h.batches().length, 5); assert.equal(h.batches()[0].props['aria-expanded'], true); assert.ok(h.batches().slice(1).every(batch => batch.props['aria-expanded'] === false));
    assert.equal(h.text().includes('查找 “q0”'), false); const before = h.requests.length;
    h.button('清空结果').props.onClick(); h.render(); assert.equal(h.batches().length, 0); assert.equal(h.requests.length, before); assert.match(h.text(), /日志文件未改变/);
    const persisted = JSON.parse(h.storage.get('dsh-session-file-search-v2:A')); assert.equal(persisted.length, 6); assert.equal(persisted[0].query, 'q5');
  } finally { h.dispose(); }
});

test('复制此批正文遍历全部分页且不混入分组头，取消中途复制不写入部分结果', async () => {
  const h = await harness(); try {
    h.render(); await h.reply(h.start('ERROR'), page()); h.render(); h.button('复制此批正文').props.onClick(); h.render();
    const original = h.requests.at(-1); await h.reply(original, page()); h.render();
    const next = h.requests.at(-1); assert.notEqual(next, original); assert.equal(new URL(next.url, 'http://localhost').searchParams.get('offset'), '2');
    await h.reply(next, page('A', { offset: 2, entries: [match(2)], nextOffset: null })); h.render();
    assert.deepEqual(h.clipboard, ['ERROR + ERROR\nERROR + ERROR\nERROR next']); assert.match(h.text(), /已复制 3 条结果正文/);
    h.button('复制此批正文').props.onClick(); h.render(); await h.reply(h.requests.at(-1), page()); h.render(); const cancelled = h.requests.at(-1);
    h.button('停止').props.onClick(); h.render(); assert.equal(cancelled.signal.aborted, true);
    await h.reply(cancelled, page('A', { offset: 2, entries: [match(2)], nextOffset: null })); h.render(); assert.equal(h.clipboard.length, 1);
  } finally { h.dispose(); }
});

test('跨文件完整条件历史保存模式、整词、大小写及文件范围，复用只填回条件而不自动查找', async () => {
  const h = await harness(); try {
    h.render(); h.input().props.onChange({ target: { value: 'ERROR|failed' } });
    h.find(node => node.type === 'input' && node.props.type === 'radio' && node.props.value === 'regex').props.onChange(); h.render();
    const labels = h.all(node => node.type === 'label');
    for (const label of ['全词匹配', '区分大小写', '每行仅一条']) {
      const row = labels.find(node => Array.isArray(node.props.children) && node.props.children.includes(label)); assert.ok(row, label);
      row.props.children.find(node => node?.type === 'input').props.onChange({ target: { checked: true } });
    }
    h.find(node => node.type === 'input' && node.props['aria-label'] === '当前会话文件名通配过滤').props.onChange({ target: { value: '*.txt !*noise*' } }); h.render();
    h.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); h.render(); const pending = h.requests.at(-1), params = new URL(pending.url, 'http://localhost').searchParams;
    assert.equal(params.get('mode'), 'regex'); assert.equal(params.get('wholeWord'), 'true'); assert.equal(params.get('caseSensitive'), 'true'); assert.equal(params.get('oneEntryPerLine'), 'true'); assert.equal(params.get('filePattern'), '*.txt !*noise*');
    await h.reply(pending, page('A', { entries: [], nextOffset: null })); h.render();
    const saved = JSON.parse(h.storage.get('dsh-session-file-search-v2:A'))[0]; assert.equal(saved.mode, 'regex'); assert.equal(saved.filePattern, '*.txt !*noise*');
    h.find(node => node.type === 'input' && node.props.type === 'radio' && node.props.value === 'normal').props.onChange(); h.render();
    const before = h.requests.length; h.button('复用').props.onClick(); h.render(); assert.equal(h.requests.length, before);
    assert.equal(h.find(node => node.type === 'input' && node.props.type === 'radio' && node.props.value === 'regex').props.checked, true);
  } finally { h.dispose(); }
});
