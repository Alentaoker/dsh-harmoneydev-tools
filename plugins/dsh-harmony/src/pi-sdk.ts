import { randomUUID } from 'node:crypto';
import { dataRoot, getHost } from './state';
export const defineTool = (definition: any) => definition;
export const getAgentDir = () => dataRoot;

/** Preserve Piora's perception interface while using Harness providers and credentials. */
export class ModelRuntime {
  private models: any[] = [];
  static async create() {
    const runtime = new ModelRuntime();
    const ctx = getHost();
    for (const provider of ctx.llm.listProviders()) {
      const models = await ctx.llm.listModels(provider.id);
      runtime.models.push(...models.map((m: any) => ({ ...m, input: m.inputModalities || ['text'] })));
    }
    return runtime;
  }
  getError() { return undefined; }
  getModels() { return this.models; }
  getModel(provider: string, id: string) { return this.models.find(m => m.provider === provider && m.id === id); }
  hasConfiguredAuth(provider: string) { return getHost().llm.listProviders().some((p: any) => p.id === provider); }
  async completeSimple(model: any, request: any, options: any) {
    const ctx = getHost();
    const messages: any[] = [{ id: randomUUID(), role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: request.systemPrompt }] }];
    for (const input of request.messages) {
      const content = [];
      for (const block of input.content) {
        if (block.type === 'image') {
          const attachment = await ctx.attachments.saveImage({ data: Buffer.from(block.data, 'base64'), mediaType: block.mimeType, name: 'Harmony screen.png' });
          content.push({ type: 'image', attachment });
        } else content.push(block);
      }
      messages.push({ id: randomUUID(), role: input.role, source: { kind: 'user' }, content });
    }
    let text = '', stopReason = 'stop', errorMessage;
    for await (const chunk of ctx.llm.stream({ provider: model.provider, model: model.id, maxTokens: options.maxTokens, messages, signal: options.signal })) {
      if (chunk.type === 'text-delta') text += chunk.text;
      if (chunk.type === 'finish' && ['error', 'aborted'].includes(chunk.reason.kind)) {
        stopReason = chunk.reason.kind; errorMessage = chunk.reason.failure?.message;
      }
    }
    return { content: [{ type: 'text', text }], stopReason, errorMessage };
  }
}
