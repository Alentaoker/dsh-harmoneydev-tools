export const name = 'dshHarmony';
export const inject = ['tools', 'systemPrompt', 'dshHarmony'];
export function apply(ctx: any) {
  ctx.effect(() => ctx.tools.register(ctx.dshHarmony.tool), 'dshHarmony: phone tool');
  ctx.effect(() => ctx.systemPrompt.section({ name: 'dshHarmony:phone-operator', order: 850, text: ctx.dshHarmony.prompt }), 'dshHarmony: capability');
}
