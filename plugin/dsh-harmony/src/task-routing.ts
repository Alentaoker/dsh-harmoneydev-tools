// Validation-context coordination for the Harmony tool wrapper.
//
// This layer no longer forces `e2e_phone.run` or an inner AI loop. It only
// answers two questions: does this session have an active validation attempt,
// and may an automatic control action be dispatched right now? Device
// exclusivity, busy conflicts, cancellation and lease handling stay in the
// Harmony backend.
const observationOperations = new Set([
  'help', 'capabilities', 'discover', 'list_devices', 'applications', 'observe_screen',
  'observe_page', 'take_screenshot', 'list_processes', 'read_logs', 'get_raw_logs',
  'release_control', 'status',
]);

export function isObservation(operation: unknown): boolean {
  return typeof operation === 'string' && observationOperations.has(operation);
}

export function isMutating(operation: unknown): boolean {
  return typeof operation === 'string' && !observationOperations.has(operation);
}

export const taskRoutingGuidance = [
  'Harmony 是唯一的设备执行与观察层。含结果检查的手机任务：先用 e2e_phone.save_task 保存检查点，用户安装并确认后用 begin_validation 建验证轮次，再用本工具操作/观察，最后 record_checkpoint 与 finish_validation。',
  '不再强制 e2e_phone.run，也没有内层独立 AI 验收；是否需要留存验证记录由当前会话的任务上下文决定。',
  '人工模式（attempt.mode=human）下只允许只读观察与日志：不得获取自动化控制租约、不得派发点击/输入/启动应用、不得抢投屏。用户自己操作的变化只能作为“用户声明的动作”记录，不能伪造自动派发回执。',
  '派发与效果分开：not-sent/sent/unknown 不等于 confirmed/not-effective。超时、取消或 ACTION_MAY_HAVE_COMMITTED 后先重新观察，不要自动重发可能已提交的动作。',
].join('');

export interface ActiveAttempt {
  taskId: string;
  attemptId: string;
  mode: 'ai' | 'human';
  serial?: string;
}

export interface TaskRouter {
  activeAttempt(sessionId: string): ActiveAttempt | null;
}

export interface RoutingDecision {
  attempt: ActiveAttempt | null;
  humanMode: boolean;
  mutating: boolean;
}

export function createTaskRouting() {
  let router: TaskRouter | undefined;
  return {
    get enabled() { return !!router; },
    register(value: TaskRouter) {
      if (router) throw new Error('A validation router is already registered');
      router = value;
      return () => { if (router === value) router = undefined; };
    },
    check(sessionId: string, args: any): RoutingDecision {
      const mutating = isMutating(args?.operation);
      const attempt = router?.activeAttempt(sessionId) ?? null;
      if (!attempt) return { attempt: null, humanMode: false, mutating };
      const humanMode = attempt.mode === 'human';
      if (humanMode && mutating) {
        throw new Error('[HUMAN_MODE_READ_ONLY] 当前验证轮次是人工模式：只允许只读观察与日志，不能派发控制动作。请把用户的操作记为人工声明，或让用户结束本轮后再选择 AI 模式。');
      }
      return { attempt, humanMode, mutating };
    },
  };
}
