const inspections = new Set(['help', 'capabilities', 'discover', 'list_devices', 'applications', 'observe_screen', 'observe_page', 'take_screenshot', 'list_processes', 'read_logs', 'get_raw_logs', 'release_control']);

export const taskRoutingGuidance = '当 e2e_phone 可用时，含结果检查的手机任务必须从 e2e_phone.run 开始，由它统一操作、采集日志、独立验收和保存报告。status/resolve_app 只是查询，不是执行测试。不要查完 E2E 后转到 Harmony 点击、输入或 run_scenario。Harmony 的观察可用于识别当前页面和日志宿主；小艺 Work 等名称可能是应用内页面，不是独立包名。只有用户明确要求不留 E2E 记录的直控或 E2E 不支持的操作，才传 execution:"direct" 和 directReason 说明，结果必须注明未创建 E2E 测试。只检查当前页用 E2E runMode:"verify_current"，不能追认此前的操作。';

export function createTaskRouting() {
  let router: undefined | { busy: () => boolean };
  return {
    get enabled() { return !!router; },
    register(value: { busy: () => boolean }) {
      if (router) throw new Error('An E2E task router is already registered');
      router = value;
      return () => { if (router === value) router = undefined; };
    },
    check(args: any) {
      if (!router || inspections.has(args.operation)) return;
      if (router.busy()) throw new Error('[E2E_ACTIVE] 手机测试正在执行或收尾，请等待报告；不要用直控插入动作。');
      if (args.execution !== 'direct' || typeof args.directReason !== 'string' || !args.directReason.trim()) {
        throw new Error('[E2E_REQUIRED] 请用 e2e_phone.run 执行并留存测试；status/resolve_app 不会创建报告。明确选择无 E2E 记录的直控时，需 execution:"direct" 和 directReason。');
      }
    },
  };
}
