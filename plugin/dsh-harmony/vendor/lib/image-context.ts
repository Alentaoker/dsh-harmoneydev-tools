import type { Agent } from "@earendil-works/pi-agent-core";
import { prepareModelImageContext, type ModelImageCache } from "./model-image-context";

export const HISTORICAL_IMAGE_PLACEHOLDER = "[Historical image omitted from this request. The original remains in the chat record. Ask the user to attach it again if visual inspection is needed; do not infer unseen details.]";

/** Project outgoing context only; never mutate the transcript or attachment bytes. */
export function omitHistoricalImages<T>(messages: readonly T[]): T[] {
  const lastUser = messages.findLastIndex((message) => (message as { role?: string } | null)?.role === "user");
  return messages.map((message, index) => {
    if (lastUser >= 0 && index >= lastUser) return message;
    const entry = message as { role?: string; content?: unknown } | null;
    if (!entry || !["user", "toolResult", "custom"].includes(entry.role ?? "") || !Array.isArray(entry.content)) return message;
    let changed = false;
    const content = entry.content.map((block) => {
      if (block?.type !== "image") return block;
      changed = true;
      return { type: "text", text: HISTORICAL_IMAGE_PLACEHOLDER };
    });
    return changed ? { ...message, content } : message;
  });
}

export function installImageContextPolicy(agent: Pick<Agent, "transformContext">): void {
  const previous = agent.transformContext?.bind(agent);
  const cache: ModelImageCache = new WeakMap();
  agent.transformContext = async (messages, signal) => {
    // Keep extension context hooks and cancellation, then apply the outgoing policy.
    const context = previous ? await previous(messages, signal) : messages;
    return prepareModelImageContext(omitHistoricalImages(context), signal, cache);
  };
}
