import type { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  readSystemPromptConfig,
  resolveSystemPromptSelection,
  type SystemPromptConfig,
} from "./system-prompt-config";
import type { SessionSystemPromptBinding, SystemPromptSelection } from "./system-prompt-types";

export const SESSION_SYSTEM_PROMPT_ENTRY_TYPE = "piora-system-prompt-binding";

type SessionEntryLike = {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
};

function copy(binding: SessionSystemPromptBinding): SessionSystemPromptBinding {
  return { ...binding };
}

export function isSessionSystemPromptBinding(value: unknown): value is SessionSystemPromptBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Partial<SessionSystemPromptBinding>;
  return binding.version === 1
    && Number.isInteger(binding.revision)
    && (binding.revision ?? 0) > 0
    && (binding.source === "default" || binding.source === "template")
    && (binding.templateId === null || typeof binding.templateId === "string")
    && (binding.templateName === null || typeof binding.templateName === "string")
    && (binding.prompt === null || typeof binding.prompt === "string")
    && typeof binding.appliedAt === "string";
}

export function readLatestSessionSystemPromptBinding(
  entries: readonly SessionEntryLike[],
): SessionSystemPromptBinding | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== SESSION_SYSTEM_PROMPT_ENTRY_TYPE) continue;
    if (isSessionSystemPromptBinding(entry.data)) return copy(entry.data);
  }
  return null;
}

export function createSessionSystemPromptBinding(
  selection: SystemPromptSelection,
  config: SystemPromptConfig = readSystemPromptConfig(),
  previous: SessionSystemPromptBinding | null = null,
): SessionSystemPromptBinding {
  const resolved = resolveSystemPromptSelection(config, selection);
  return {
    version: 1,
    revision: (previous?.revision ?? 0) + 1,
    source: resolved.source,
    templateId: resolved.templateId,
    templateName: resolved.templateName,
    prompt: resolved.prompt,
    appliedAt: new Date().toISOString(),
  };
}

export function appendSessionSystemPromptBinding(
  sessionManager: Pick<SessionManager, "appendCustomEntry">,
  binding: SessionSystemPromptBinding,
): string {
  return sessionManager.appendCustomEntry(SESSION_SYSTEM_PROMPT_ENTRY_TYPE, binding);
}

export function copySessionSystemPromptBinding(binding: SessionSystemPromptBinding): SessionSystemPromptBinding {
  return { ...binding, revision: 1, appliedAt: new Date().toISOString() };
}

export function resolveSessionSystemPrompt(
  entries: readonly SessionEntryLike[],
  basePrompt: string | undefined,
  config: SystemPromptConfig = readSystemPromptConfig(),
): string | undefined {
  const binding = readLatestSessionSystemPromptBinding(entries);
  if (binding) return binding.prompt === null ? basePrompt : binding.prompt;
  const resolvedDefault = resolveSystemPromptSelection(config, { mode: "default" });
  return resolvedDefault.prompt === null ? basePrompt : resolvedDefault.prompt;
}

export function selectionForSessionSystemPromptBinding(
  binding: SessionSystemPromptBinding | null,
): SystemPromptSelection {
  if (!binding || binding.source === "default" || !binding.templateId) return { mode: "default" };
  return { mode: "template", templateId: binding.templateId };
}
