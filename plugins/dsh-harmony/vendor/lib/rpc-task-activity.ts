import type { TaskRuntimeActivity } from "./task-status";

export const TASK_ACTIVITY_MAX_LENGTH = 240;
export const TASK_ACTIVITY_STREAM_INTERVAL_MS = 300;

export function compactTaskActivityText(
  value: unknown,
  maxLength = TASK_ACTIVITY_MAX_LENGTH,
): string {
  const text = typeof value === "string" ? value : (() => {
    try { return JSON.stringify(value); } catch { return String(value ?? ""); }
  })();
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `…${compact.slice(-(maxLength - 1))}`;
}

export function activityFromMessage(
  message: unknown,
): Pick<TaskRuntimeActivity, "kind" | "message"> | null {
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    const text = compactTaskActivityText(content);
    return text ? { kind: "assistant", message: text } : null;
  }
  if (!Array.isArray(content)) return null;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index];
    if (!block || typeof block !== "object") continue;
    const candidate = block as Record<string, unknown>;
    if (candidate.type === "toolCall") {
      const name = compactTaskActivityText(candidate.toolName ?? candidate.name, 64);
      const input = compactTaskActivityText(candidate.input ?? candidate.arguments, 160);
      const detail = [name, input].filter(Boolean).join(": ");
      if (detail) return { kind: "tool", message: detail };
    }
    if (candidate.type === "text") {
      const text = compactTaskActivityText(candidate.text);
      if (text) return { kind: "assistant", message: text };
    }
    if (candidate.type === "thinking") {
      const thinking = compactTaskActivityText(candidate.thinking);
      if (thinking) return { kind: "thinking", message: thinking };
    }
  }
  return null;
}
