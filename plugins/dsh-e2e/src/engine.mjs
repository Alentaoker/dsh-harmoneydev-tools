import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineEngine, resolveExpression, EngineError } from 'e2e/engine';
import sharp from 'sharp';
import { rpc } from './rpc.mjs';

export function roleFor(node) {
  if (/TextInput|TextArea|SearchField|^Search$/i.test(node.type || '')) return 'textbox';
  if (/Checkbox/i.test(node.type || '')) return 'checkbox';
  if (/Toggle|Switch/i.test(node.type || '')) return 'switch';
  if (/Button/i.test(node.type || '') || node.clickable) return 'button';
  if (/ListItem/i.test(node.type || '')) return 'listitem';
  if (/Image/i.test(node.type || '')) return 'img';
  return node.scrollable ? 'region' : 'text';
}
export function convertSnapshot(snapshot, viewport) {
  const nodes = snapshot.nodes || [], byRef = new Map(nodes.map(n => [n.ref, n]));
  const seen = new Map(), bindings = new Map();
  const app = snapshot.quality?.appId || snapshot.targetApp || 'foreground';
  const converted = nodes.map(node => {
    const ancestors = []; let parent = byRef.get(node.parentRef); const visited = new Set();
    while (parent && !visited.has(parent.ref) && ancestors.length < 20) { visited.add(parent.ref); ancestors.push(`${parent.type}:${parent.id || ''}`); parent = byRef.get(parent.parentRef); }
    const signature = JSON.stringify([app, ancestors.reverse(), node.type, node.id || node.description || node.hint || node.text || '']);
    const occurrence = seen.get(signature) || 0; seen.set(signature, occurrence + 1);
    const id = 'h-' + createHash('sha256').update(signature + ':' + occurrence).digest('hex').slice(0, 20);
    bindings.set(id, { ...node, generation: snapshot.generation });
    const b = node.bounds;
    const secure = /password|密码|口令/i.test(`${node.type || ''} ${node.id || ''} ${node.hint || ''}`);
    const editable = roleFor(node) === 'textbox';
    return { ref: { id, revision: '' }, role: roleFor(node), name: (secure ? node.hint || '密码' : node.description || node.text || node.hint || '').slice(0, 256),
      text: secure ? '' : (node.text || '').slice(0, 512), ...(editable && !secure ? { value: node.text || '' } : {}),
      testId: node.id, inputPurpose: secure ? 'password' : 'none',
      states: { disabled: node.enabled === false, hidden: node.visible === false, focused: !!node.focused, ...(node.checked === undefined ? {} : { checked: node.checked }), ...(node.selected === undefined ? {} : { selected: node.selected }), secure },
      ...(b ? { rect: { x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top } } : {}),
      attributes: { type: node.type || '', ...(node.hint ? { placeholder: node.hint } : {}) } };
  });
  return { snapshot: { location: `harmony:${app}`, root: { ref: { id: 'harmony-root', revision: '' }, role: 'window', children: converted }, viewport, truncated: snapshot.quality?.treeStatus !== 'valid' || !snapshot.quality?.scopeComplete }, bindings };
}
function mappedError(error, dispatched = false) {
  if (error instanceof EngineError) return error;
  const stale = ['STALE_SNAPSHOT', 'STALE_GENERATION', 'NODE_STALE'].includes(error.code);
  return new EngineError(stale ? 'NODE_STALE' : dispatched ? 'ACTION_MAY_HAVE_COMMITTED' : 'NOT_ACTIONABLE', error.message, { retryable: stale });
}
export function harmonyEngine() {
  let bindings = new Map(), latest, artifactDir, attempt;
  async function capture(context, pixels = false) {
    const raw = await rpc('observe', { pixels }, context.signal);
    if (!raw.nodes || ['unavailable', 'parse-error'].includes(raw.quality?.treeStatus)) throw new EngineError('NOT_ACTIONABLE', '鸿蒙控件树不可用，请检查设备连接和当前页面');
    const result = convertSnapshot(raw, raw.viewport); bindings = result.bindings; latest = raw;
    if (pixels && raw.pixels) {
      const data = Buffer.from(raw.pixels.data, 'base64');
      const masks = result.snapshot.root.children.filter(n => n.states.secure && n.rect).map(n => ({ input: { create: { width: Math.max(1, Math.round(n.rect.width)), height: Math.max(1, Math.round(n.rect.height)), channels: 3, background: '#111111' } }, left: Math.max(0, Math.round(n.rect.x)), top: Math.max(0, Math.round(n.rect.y)) }));
      // Refuse mismatched geometry instead of sending an incorrectly masked image.
      const metadata = await sharp(data).metadata();
      if (metadata.width !== raw.viewport.width || metadata.height !== raw.viewport.height) throw new EngineError('NOT_ACTIONABLE', '截图尺寸与控件坐标不一致');
      result.snapshot.pixels = { data: await sharp(data).composite(masks).png().toBuffer(), mediaType: 'image/png', width: metadata.width, height: metadata.height, scale: 1 };
      result.snapshot.maskedRegionCount = masks.length;
    }
    return result.snapshot;
  }
  async function perform(ref, action, context) {
    try {
      if (ref.id !== 'harmony-root') { await capture(context); if (!bindings.has(ref.id)) throw new EngineError('NODE_STALE', '控件已变化，请重新观察', { retryable: true }); }
      const node = bindings.get(ref.id);
      if (action.sensitive || node && /password|密码|口令/i.test(`${node.type} ${node.id} ${node.hint}`)) throw new EngineError('UNSUPPORTED_CAPABILITY', '首版不提供密码输入');
      await rpc('perform', { node, action, viewport: latest?.viewport }, context.signal);
    } catch (error) { throw mappedError(error, true); }
  }
  return defineEngine({ name: 'dsh-harmony', version: '0.1.0', spiVersion: 1, platform: 'harmony', workers: 1,
    actions: ['tap', 'fill', 'clear', 'focus', 'swipe', 'press'], pointerActions: ['tap', 'swipeTo'],
    async init() {}, async dispose() {},
    async startAttempt(context) { artifactDir = context.artifactsDir; attempt = context; const info = await rpc('device', {}, context.signal); context.environment({ device: info.name || info.model || 'HarmonyOS', os: info.osVersion || '', api: info.apiVersion || '' }); },
    async endAttempt() { if (attempt) { const result = await rpc('logs'); for (const entry of result.entries) attempt.appLog({ source: 'system', level: ['fatal', 'error'].includes(entry.level) ? 'error' : entry.level === 'warn' ? 'warning' : 'info', text: `[${entry.timestamp || entry.capturedAt}] ${entry.tag || ''} ${entry.message}` }); } attempt = undefined; },
    observe: (context, options) => capture(context, !!options?.pixels),
    async locate(expression, context) { const screen = await capture(context); return resolveExpression(expression, screen.root.children || []); },
    perform,
    async performAt(point, action, context) { try { await capture(context); await rpc('pointer', { point, action, generation: latest.generation }, context.signal); } catch (error) { throw mappedError(error, true); } },
    session: { async restart(context) { await rpc('open', {}, context.signal); }, async back(context) { await rpc('key', { key: 'back' }, context.signal); } },
    keyboard: { async type(text, options, context) { if (!options.replace) throw new EngineError('UNSUPPORTED_CAPABILITY', '鸿蒙输入目前只支持替换字段'); await rpc('input', { text }, context.signal); }, async press(key, context) { if (key !== 'Enter' && key !== 'Escape') throw new EngineError('UNSUPPORTED_CAPABILITY', '不支持此按键'); await rpc('key', { key: key === 'Enter' ? 'enter' : 'back' }, context.signal); }, async dismiss(context) { await rpc('key', { key: 'back' }, context.signal); } },
    fixtures: { device: context => context.fixture('device', { home: () => rpc('key', { key: 'home' }, context.signal), back: () => rpc('key', { key: 'back' }, context.signal) }, { home: { kind: 'resource' }, back: { kind: 'resource' } }) },
    artifacts: { async screenshot(label, context) { const screen = await capture(context, true); if (!screen.pixels) throw new EngineError('UNSUPPORTED_CAPABILITY', '截图不可用'); const file = `screen-${Date.now()}.png`; await mkdir(artifactDir, { recursive: true }); await writeFile(join(artifactDir, file), screen.pixels.data); return file; } },
  });
}
