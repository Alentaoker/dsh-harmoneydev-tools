import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { maskedEvidence } from './evidence.mjs';
import { convertSnapshot } from './engine.mjs';

export async function requireVisualModel(ctx, model, signal) {
  const info = await ctx.llm.resolveModelInfo?.(model?.provider, model?.model, signal);
  if (!info?.inputModalities?.includes('image') || !ctx.attachments?.saveImage) throw Object.assign(Error('当前会话模型没有已确认的图像输入能力；不能只凭 Image 节点验收猫图。请选择支持图像的模型，或明确只做 semantic 结构验收。'), { code: 'VISION_UNAVAILABLE' });
}
export async function visualVerification(ctx, manager, job, input, signal) {
  await requireVisualModel(ctx, job.model, signal);
  const raw = await manager.snapshot({ serial: job.device.serial, leaseToken: job.lease.token, includeTree: true, includeScreenshot: true, signal });
  const geometry = await manager.getDisplayGeometry(job.device.serial, signal), data = await maskedEvidence(raw, geometry);
  const file = `verification-${(job.verificationEvidence?.length || 0) + 1}.png`;
  await writeFile(join(job.directory, file), data);
  (job.evidence ||= []).push({ label: '独立视觉验收输入', file });
  (job.verificationEvidence ||= []).push({ file, capturedAt: raw.capturedAt, generation: raw.generation, revision: raw.revision });
  const snapshot = convertSnapshot(raw, { width: geometry.nativeWidth, height: geometry.nativeHeight }).snapshot, prompt = JSON.parse(input);
  prompt.screen = JSON.stringify(snapshot.root.children);
  prompt.evidence = '截图与上述控件树来自同一次独立观察。按截图实际内容验收，不要以图片节点存在代替内容判断。';
  const attachment = await ctx.attachments.saveImage({ data, mediaType: 'image/png', name: 'E2E visual verification.png' });
  return [{ type: 'text', text: JSON.stringify(prompt) }, { type: 'image', attachment }];
}
