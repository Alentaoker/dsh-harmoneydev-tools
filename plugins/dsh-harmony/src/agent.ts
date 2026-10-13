export const name = 'dshHarmony';
export const inject = ['tools', 'systemPrompt', 'dshHarmony'];
export function apply(ctx: any) {
  ctx.effect(() => ctx.tools.register(ctx.dshHarmony.automation.taskRouting.enabled ? { ...ctx.dshHarmony.tool, description: ctx.dshHarmony.taskRoutingGuidance } : ctx.dshHarmony.tool), 'dshHarmony: phone tool');
  ctx.effect(() => ctx.systemPrompt.section({ name: 'dshHarmony:phone-operator', order: 850, text: ctx.dshHarmony.automation.taskRouting.enabled ? ctx.dshHarmony.taskRoutingGuidance + '\n可用 help+topic 查具体接口；观察返回新鲜ref，tap要求ref和generation，long_press要求x/y/generation，wait要求waitMs。Harmony直控的操作前后变化检查不等于E2E目标断言。完成直控后release_control。' : ctx.dshHarmony.prompt }), 'dshHarmony: capability');
}
