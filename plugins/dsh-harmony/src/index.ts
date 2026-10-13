import { mkdirSync } from 'node:fs';
import { setHost, dataRoot } from './state';
import pioraHarmony from '../vendor/extensions/piora-harmony';
import { getHarmonyDeviceManager } from '../vendor/lib/harmony';
import { beginPromptRun, getActivePromptRun, finishPromptRun } from '../vendor/lib/prompt-run-registry';
import { routes } from './routes';
import { createTaskRouting, taskRoutingGuidance } from './task-routing';

export const name = 'dshHarmony';
export const inject = ['connection', 'sessions', 'llm', 'attachments'];
export function apply(ctx: any) {
  mkdirSync(dataRoot, { recursive: true });
  setHost(ctx);
  const taskRouting = createTaskRouting();
  let original: any, prompt = '';
  pioraHarmony({
    registerTool(tool: any) { original = tool; },
    on(_event: string, callback: any) { prompt = callback({ systemPrompt: '', systemPromptOptions: { selectedTools: ['harmony_control'] } }).systemPrompt; },
  } as any);
  const tool = {
    name: original.name, description: original.description,
    parameters: { type: 'object', properties: { operation: { type: 'string' }, topic: { type: 'string' }, input: { type: 'object', additionalProperties: {} }, execution: { type: 'string', enum: ['direct'], description: '仅明确选择不留 E2E 记录的直控时使用' }, directReason: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['operation'], additionalProperties: false },
    executionMode: { kind: 'exclusive' },
    output: { schema: {}, render: (_args: any, value: any) => value.content, presentationMeta: (_args: any, value: any) => value.details },
    async execute(args: any, exec: any) {
      if (!exec.agent) throw new Error('dshHarmony requires an active Harness session');
      exec.signal.throwIfAborted();
      taskRouting.check(args);
      const sessionId = exec.agent.id;
      if (!getActivePromptRun(sessionId)) beginPromptRun(sessionId);
      const result = await original.execute(exec.callId, args, exec.signal, undefined, { sessionManager: { getSessionId: () => sessionId } });
      if (result.isError) throw new Error(result.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n') || 'Harmony operation failed');
      const content = [];
      for (const block of result.content) {
        if (block.type === 'image') {
          const attachment = await ctx.attachments.saveImage({ data: Buffer.from(block.data, 'base64'), mediaType: block.mimeType, name: 'Harmony screen.png' });
          content.push({ type: 'image', attachment });
        } else content.push(block);
      }
      if (taskRouting.enabled && args.execution === 'direct') content.push({ type: 'text', text: '本次为明确选择的 Harmony 直接调用，未创建 E2E 运行，未由 E2E 采集日志、独立验收或保存测试报告。' });
      return JSON.parse(JSON.stringify({ ...result, content, execution: { kind: 'direct', e2eRunCreated: false } }));
    },
  };
  const release = ctx.reflect.provide('dshHarmony', { tool, prompt, taskRoutingGuidance, automation: {
    getManager: getHarmonyDeviceManager, taskRouting,
    async acquireForTask(options: any) {
      const identity = getActivePromptRun(options.owner.sessionId);
      const handoffFrom = identity ? { kind: 'agent' as const, id: identity.runId, sessionId: identity.sessionId } : undefined;
      const lease = await getHarmonyDeviceManager().acquireLease({ ...options, handoffFrom });
      if (identity) await finishPromptRun(identity, 'idle');
      return lease;
    },
  } });
  ctx.effect(() => release, 'dshHarmony: bridge');
  for (const route of routes) ctx.effect(() => ctx.connection.fetch.register(route), `dshHarmony: ${route.path}`);
  ctx.on('agent/turn-stopping', async ({ agent }: any) => { await finishPromptRun(getActivePromptRun(agent.id), 'idle'); });
  ctx.on('session/disposed', async (session: any) => { await finishPromptRun(getActivePromptRun(session.id), 'destroy'); });
  ctx.effect(() => async () => {
    for (const session of ctx.sessions.list()) await finishPromptRun(getActivePromptRun(session.id), 'destroy');
    await getHarmonyDeviceManager().dispose();
  }, 'dshHarmony: cleanup');
}
