// Pure Harmony snapshot projection. No third-party runner import: this module is
// safe to load from the plugin entry point whether or not any execution package
// is installed. Evidence masking stays in evidence.mjs; geometry bookkeeping
// stays here so every consumer records the same coordinate space.
import { createHash } from 'node:crypto';

export function roleFor(node) {
  if (/TextInput|TextArea|SearchField|^Search$/i.test(node.type || '')) return 'textbox';
  if (/Checkbox/i.test(node.type || '')) return 'checkbox';
  if (/Toggle|Switch/i.test(node.type || '')) return 'switch';
  if (/Button/i.test(node.type || '') || node.clickable) return 'button';
  if (/ListItem/i.test(node.type || '')) return 'listitem';
  if (/Image/i.test(node.type || '')) return 'img';
  return node.scrollable ? 'region' : 'text';
}

const securePattern = /password|密码|口令/i;

export function isSecureNode(node) {
  return securePattern.test(`${node?.type || ''} ${node?.id || ''} ${node?.hint || ''}`);
}

/** Quality of one observation, reported instead of guessed. */
export function snapshotQuality(raw) {
  const treeStatus = raw?.quality?.treeStatus;
  const complete = treeStatus === 'valid' && raw?.quality?.scopeComplete === true;
  return {
    treeStatus: treeStatus || 'unknown',
    scopeComplete: raw?.quality?.scopeComplete === true,
    complete,
    // A node that exists is not proof that an image was inspected.
    visualInspected: false,
    reasons: complete ? [] : [`控件树状态 ${treeStatus || 'unknown'}，不完整观察不能作为验收证据`],
  };
}

export function viewportOf(geometry) {
  if (!geometry || !Number.isFinite(geometry.nativeWidth) || !Number.isFinite(geometry.nativeHeight)) {
    throw new Error('缺少设备原生尺寸，不能换算坐标');
  }
  return { width: geometry.nativeWidth, height: geometry.nativeHeight };
}

/**
 * Geometry contract shared by evidence, events and UI. `frame` is what the
 * screenshot is captured in, `native` is what refs and touch use. Never treat a
 * point taken from a scaled report image as a native coordinate.
 */
export function geometryRecord(raw, geometry) {
  const nativeWidth = geometry?.nativeWidth;
  const nativeHeight = geometry?.nativeHeight;
  if (!Number.isFinite(nativeWidth) || !Number.isFinite(nativeHeight)) throw new Error('缺少原生几何信息');
  const frameWidth = raw?.screenshot?.width ?? raw?.viewport?.width ?? nativeWidth;
  const frameHeight = raw?.screenshot?.height ?? raw?.viewport?.height ?? nativeHeight;
  return {
    geometryId: raw?.geometryId || geometry?.geometryId || `g-${nativeWidth}x${nativeHeight}`,
    coordinateSpace: 'native',
    nativeSize: { width: nativeWidth, height: nativeHeight },
    displaySize: { width: frameWidth, height: frameHeight },
    orientation: raw?.orientation ?? geometry?.orientation ?? 'unknown',
    captureTime: raw?.capturedAt || new Date().toISOString(),
    scale: { x: frameWidth ? nativeWidth / frameWidth : 1, y: frameHeight ? nativeHeight / frameHeight : 1 },
    generation: raw?.generation ?? null,
    revision: raw?.revision ?? null,
  };
}

/** Refuse stale or foreign geometry instead of silently mapping old points. */
export function assertGeometry(record, { generation, geometryId } = {}) {
  if (record.coordinateSpace !== 'native') throw new Error('坐标空间不是原生的，拒绝换算');
  if (generation !== undefined && record.generation !== null && record.generation !== generation) throw new Error('观察已过期，请重新观察后再换算坐标');
  if (geometryId !== undefined && record.geometryId !== geometryId) throw new Error('几何信息已变化，请重新观察');
  return record;
}

export function toNativePoint(point, record) {
  const { scale } = assertGeometry(record);
  return { x: Math.round(point.x * scale.x), y: Math.round(point.y * scale.y) };
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
    const secure = isSecureNode(node);
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
