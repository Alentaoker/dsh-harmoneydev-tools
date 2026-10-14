import { completeCompanionFocusTimer } from "./companion-focus-timer";
import type {
  CompanionDecision,
  CompanionFocusTimerPhase,
  CompanionRuntimeState,
} from "./companion-runtime";

export interface CompanionFocusCompletion {
  state: CompanionRuntimeState;
  completedPhase: CompanionFocusTimerPhase;
  decision: CompanionDecision | null;
}

export function completeExpiredCompanionFocusTimer(
  state: CompanionRuntimeState,
  now = Date.now(),
  createId: () => string = () => crypto.randomUUID(),
): CompanionFocusCompletion | null {
  const timer = state.focusTimer;
  if (timer.status !== "running" || timer.endsAt === null || timer.endsAt > now) return null;

  const completedPhase = timer.phase;
  const linkedTodo = state.todos.find((todo) => todo.id === timer.linkedTodoId);
  const focusCompleted = completedPhase === "focus";
  const decision: CompanionDecision | null = timer.petReminderEnabled ? {
    id: `decision:${createId()}`,
    event: focusCompleted ? "timer.focus-completed" : "timer.break-completed",
    thoughtSummary: focusCompleted ? "这一轮专注已经完成。" : "休息时间已经结束。",
    mood: focusCompleted ? "cheerful" : "focused",
    speech: focusCompleted
      ? (linkedTodo?.text
          ? `“${linkedTodo.text.slice(0, 40)}”的专注时间到了，休息一下吧。`
          : "专注时间到了，休息一下吧。")
      : "休息结束，可以开始下一轮专注了。",
    actions: [{ kind: "speak" }, { kind: "animate", animation: "waving" }],
    observedFacts: [
      focusCompleted ? "一轮专注计时已完成" : "一轮休息计时已完成",
      ...(linkedTodo?.text ? [`绑定任务：${linkedTodo.text.slice(0, 80)}`] : []),
    ],
    nextThinkAfterSeconds: 300,
    createdAt: now,
  } : null;
  const mind = decision ? {
    ...state.mind,
    mood: decision.mood,
    lastDecision: decision,
    decisionHistory: [
      decision,
      ...state.mind.decisionHistory.filter((item) => item.id !== decision.id),
    ].slice(0, 80),
  } : state.mind;

  return {
    state: {
      ...state,
      focusTimer: completeCompanionFocusTimer(timer, now),
      mind,
    },
    completedPhase,
    decision,
  };
}
