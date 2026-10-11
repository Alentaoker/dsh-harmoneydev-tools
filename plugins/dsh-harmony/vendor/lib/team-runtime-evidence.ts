import { randomUUID } from "node:crypto";
import type { PromptRunIdentity } from "./prompt-run-registry";
import { getActiveTeamPromptContext } from "./team-prompt-context";
import { runtimeToolArgument, runtimeVerificationLabel } from "./runtime-evidence";
import { getTeamRunStore } from "./team-run-store";

export async function captureTeamRuntimeToolResult(
  identity: PromptRunIdentity,
  toolCallId: string,
  toolName: string,
  args: unknown,
  isError: boolean,
): Promise<void> {
  if (isError || toolName !== "bash") return;
  const context = getActiveTeamPromptContext(identity.sessionId);
  if (!context || context.purpose !== "task") return;
  const command = runtimeToolArgument(args, ["command"]);
  if (!command) return;
  const label = runtimeVerificationLabel(command);
  if (!label) return;
  const store = getTeamRunStore();
  const state = store.getTeamRun(context.roomId, context.teamRunId);
  if (Object.values(state.evidence).some((evidence) => evidence.toolCallId === toolCallId)) return;
  const evidence = {
    id: randomUUID(), teamRunId: state.id, taskId: context.taskId, memberId: context.memberId,
    kind: "verification", summary: `Runtime confirmed the ${label} completed successfully.`, source: "runtime",
    toolName, toolCallId, exitCode: 0, createdAt: Date.now(),
  } as const;
  await store.appendTeamRunEvents(state.roomId, state.id, state.revision, [{
    event: { type: "task.evidence_added", taskId: context.taskId, evidence }, actor: { kind: "system", id: "piora" }, causationId: toolCallId,
  }]);
}
