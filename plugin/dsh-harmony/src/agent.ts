export const name = 'dshHarmony';
export const inject = ['tools', 'systemPrompt', 'dshHarmony'];
export function apply(ctx: any) {
  ctx.effect(() => ctx.tools.register(ctx.dshHarmony.automation.taskRouting.enabled ? { ...ctx.dshHarmony.tool, description: ctx.dshHarmony.taskRoutingGuidance } : ctx.dshHarmony.tool), 'dshHarmony: phone tool');
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'dshHarmony:phone-operator',
    order: 850,
    text: ctx.dshHarmony.automation.taskRouting.enabled
      ? ctx.dshHarmony.taskRoutingGuidance + '\n可用 help+topic 查具体接口；观察返回新鲜ref，tap要求ref和generation，long_press要求x/y/generation，wait要求waitMs。Harmony 的操作前后变化检查不等于 dshE2E 检查点结论。完成直控后 release_control。'
      : ctx.dshHarmony.prompt + '\n没有安装 dshVerify（安装标识 dsh-e2e）时不会创建验证记录；不要把 Harmony 的操作结果说成已通过测试或已留存报告。',
  }), 'dshHarmony: capability');
}
