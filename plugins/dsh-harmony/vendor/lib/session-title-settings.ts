import {
  SESSION_TITLE_PROMPT,
  normalizeSessionTitlePrompt,
} from "./session-title-prompt";

export { SESSION_TITLE_PROMPT } from "./session-title-prompt";

export const SESSION_TITLE_PROMPT_STORAGE_KEY = "piora-session-title-prompt-v1";
export const SESSION_TITLE_MODEL_STORAGE_KEY = "piora-session-title-model-v1";

export interface SessionTitleModelPreference {
  provider: string;
  modelId: string;
}

export function readSessionTitlePrompt(storage?: Pick<Storage, "getItem">): string {
  if (!storage) return SESSION_TITLE_PROMPT;
  try {
    return normalizeSessionTitlePrompt(storage.getItem(SESSION_TITLE_PROMPT_STORAGE_KEY));
  } catch {
    return SESSION_TITLE_PROMPT;
  }
}

export function writeSessionTitlePrompt(
  value: string,
  storage: Pick<Storage, "setItem">,
): string {
  const normalized = normalizeSessionTitlePrompt(value);
  storage.setItem(SESSION_TITLE_PROMPT_STORAGE_KEY, normalized);
  return normalized;
}

export function resetSessionTitlePrompt(storage: Pick<Storage, "removeItem">): string {
  storage.removeItem(SESSION_TITLE_PROMPT_STORAGE_KEY);
  return SESSION_TITLE_PROMPT;
}

export function readSessionTitleModel(storage?: Pick<Storage, "getItem">): SessionTitleModelPreference | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(SESSION_TITLE_MODEL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SessionTitleModelPreference>;
    const provider = typeof parsed.provider === "string" ? parsed.provider.trim() : "";
    const modelId = typeof parsed.modelId === "string" ? parsed.modelId.trim() : "";
    return provider && modelId ? { provider, modelId } : null;
  } catch {
    return null;
  }
}

export function writeSessionTitleModel(
  value: SessionTitleModelPreference,
  storage: Pick<Storage, "setItem">,
): SessionTitleModelPreference {
  const provider = value.provider.trim();
  const modelId = value.modelId.trim();
  if (!provider || !modelId) throw new Error("A title model provider and model id are required");
  const normalized = { provider, modelId };
  storage.setItem(SESSION_TITLE_MODEL_STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

export function resetSessionTitleModel(storage: Pick<Storage, "removeItem">): null {
  storage.removeItem(SESSION_TITLE_MODEL_STORAGE_KEY);
  return null;
}
