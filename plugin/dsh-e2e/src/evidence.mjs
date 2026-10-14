import sharp from 'sharp';
export async function maskedEvidence(raw, geometry) {
  if (!raw.screenshot?.data || raw.quality?.treeStatus !== 'valid' || raw.quality?.scopeComplete !== true) throw new Error('截图或完整控件树不可用');
  const data = raw.screenshot.data, width = geometry.nativeWidth, height = geometry.nativeHeight;
  if (data.length > 10 * 1024 * 1024) throw new Error('截图超过大小限制');
  const metadata = await sharp(data, { limitInputPixels: 16000000 }).metadata();
  if (metadata.width !== width || metadata.height !== height) throw new Error('截图尺寸与控件坐标不一致');
  const masks = [];
  for (const node of raw.nodes || []) {
    if (!/password|密码|口令/i.test(`${node.type || ''} ${node.id || ''} ${node.hint || ''}`)) continue;
    const b = node.bounds;
    if (!b || ![b.left,b.top,b.right,b.bottom].every(Number.isFinite)) throw new Error('敏感字段坐标缺失，未保存截图');
    const left=Math.max(0,Math.floor(b.left)),top=Math.max(0,Math.floor(b.top)),right=Math.min(width,Math.ceil(b.right)),bottom=Math.min(height,Math.ceil(b.bottom));
    if (right>left&&bottom>top) masks.push({input:{create:{width:right-left,height:bottom-top,channels:3,background:'#111111'}},left,top});
  }
  const masked = await sharp(data).composite(masks).png().toBuffer();
  return sharp(masked).resize({width:720,height:1600,fit:'inside',withoutEnlargement:true}).png().toBuffer();
}
