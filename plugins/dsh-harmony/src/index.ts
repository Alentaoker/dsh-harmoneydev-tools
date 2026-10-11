import { mkdirSync } from 'node:fs';
import { setHost, dataRoot } from './state';
import pioraHarmony from '../vendor/extensions/piora-harmony';
import { getHarmonyDeviceManager } from '../vendor/lib/harmony';
import { beginPromptRun, getActivePromptRun, finishPromptRun } from '../vendor/lib/prompt-run-registry';
import { routes } from './routes';

export const name = 'dshHarmony';
export const inject = ['connection', 'sessions', 'llm', 'attachments'];
export function apply(ctx: any) {
  mkdirSync(dataRoot, { recursive: true });
  setHost(ctx);
  let original: any, prompt = '';
  pioraHarmony({
    registerTool(tool: any) { original = tool; },
    on(_event: string, callback: any) { prompt = callback({ systemPrompt: '', systemPromptOptions: { selectedTools: ['harmony_control'] } }).systemPrompt; },
  } as any);
  const tool = {
    name: original.name, description: original.description,
    parameters: { type: 'object', properties: { operation: { type: 'string' }, topic: { type: 'string' }, input: { type: 'object', additionalProperties: {} } }, required: ['operation'] },
    executionMode: { kind: 'exclusive' },
    output: { schema: {}, render: (_args: any, value: any) => value.content, presentationMeta: (_args: any, value: any) => value.details },
    async execute(args: any, exec: any) {
      if (!exec.agent) throw new Error('dshHarmony requires an active Harness session');
      exec.signal.throwIfAborted();
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
      return JSON.parse(JSON.stringify({ ...result, content }));
    },
  };
  const release = ctx.reflect.provide('dshHarmony', { tool, prompt, automation: { getManager: getHarmonyDeviceManager } });
  ctx.effect(() => release, 'dshHarmony: bridge');
  for (const route of routes) ctx.effect(() => ctx.connection.fetch.register(route), `dshHarmony: ${route.path}`);
  ctx.on('agent/turn-stopping', async ({ agent }: any) => { await finishPromptRun(getActivePromptRun(agent.id), 'idle'); });
  ctx.on('session/disposed', async (session: any) => { await finishPromptRun(getActivePromptRun(session.id), 'destroy'); });
  ctx.effect(() => async () => {
    for (const session of ctx.sessions.list()) await finishPromptRun(getActivePromptRun(session.id), 'destroy');
    await getHarmonyDeviceManager().dispose();
  }, 'dshHarmony: cleanup');
}
