import { createHash } from "node:crypto";
import type { CompanionTaskRecord } from "./companion-runtime";
import type { AgentMessage } from "./types";

const ACTION_HINTS = [
  /(?:修复|解决|实现|添加|新增|开发|修改|更新|优化|重构|排查|调试|完成|处理|制作|创建|接入|迁移|删除|改成|做个|做一个|帮我)/u,
  /\b(?:fix|resolve|implement|add|build|create|update|change|optimize|refactor|debug|investigate|remove|migrate|integrate|ship)\b/i,
];

function compactText(value: string, max: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

export function companionCaptureMessageText(message: AgentMessage | undefined): string {
  if (!message) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const candidate = block as Record<string, unknown>;
    return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : [];
  }).join("\n");
}

function taskTitle(prompt: string): string {
  const firstSentence = prompt
    .replace(/^(?:请|麻烦|可以|能不能|能否)\s*/u, "")
    .split(/(?:\r?\n|[。！？!?])/u, 1)[0] ?? prompt;
  return compactText(firstSentence, 160) || "已完成的会话任务";
}

export interface CompanionTaskCaptureInput {
  sessionId: string;
  sessionTitle?: string;
  project?: string;
  messages: AgentMessage[];
  entryIds: string[];
  capturedAt?: number;
}

/**
 * Builds a local, reviewable task record from the latest completed turn.
 * It deliberately uses only the last user prompt and final assistant answer;
 * full history, tool output, thinking blocks, and file contents are ignored.
 */
export function buildCompanionTaskRecord(input: CompanionTaskCaptureInput): CompanionTaskRecord | null {
  let assistantIndex = -1;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (message?.role !== "assistant") continue;
    const stopReason = (message as { stopReason?: unknown }).stopReason;
    if (stopReason === "error" || stopReason === "aborted") return null;
    if (companionCaptureMessageText(message).trim()) {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex < 0) return null;

  let userIndex = -1;
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (input.messages[index]?.role === "user") {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return null;

  const prompt = companionCaptureMessageText(input.messages[userIndex]);
  const outcome = compactText(companionCaptureMessageText(input.messages[assistantIndex]), 1_600);
  if (!prompt.trim() || !outcome || !ACTION_HINTS.some((pattern) => pattern.test(prompt))) return null;

  const sourceEntryId = input.entryIds[assistantIndex];
  if (!sourceEntryId) return null;
  const capturedAt = input.capturedAt ?? Date.now();
  const digest = createHash("sha256")
    .update(`${input.sessionId}\0${sourceEntryId}`)
    .digest("hex")
    .slice(0, 24);
  return {
    id: `task-record:${digest}`,
    sessionId: input.sessionId,
    sourceEntryId,
    title: taskTitle(prompt),
    outcome,
    ...(compactText(input.project ?? "", 160) ? { project: compactText(input.project ?? "", 160) } : {}),
    ...(compactText(input.sessionTitle ?? "", 160) ? { sessionTitle: compactText(input.sessionTitle ?? "", 160) } : {}),
    reviewStatus: "pending",
    completedAt: capturedAt,
    capturedAt,
    updatedAt: capturedAt,
  };
}
