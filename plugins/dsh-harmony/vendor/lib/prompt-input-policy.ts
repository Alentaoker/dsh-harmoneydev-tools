export const LARGE_PASTE_CHARACTER_THRESHOLD = 10_000;
export const MAX_PROMPT_MATERIAL_COUNT = 8;
export const MAX_ATTACHED_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_PROMPT_MATERIAL_BYTES = 100 * 1024 * 1024;
export const DIRECT_PROMPT_TRANSPORT_BYTES = 240 * 1024;

export interface PromptContextBudget {
  contextWindow: number;
  tokens: number | null;
  percent?: number | null;
}

/** Conservative mixed-language estimate: CJK/emoji are roughly one token,
 * while ordinary Latin text averages about four characters per token. */
export function estimatePromptTokens(text: string): number {
  let denseCharacters = 0;
  let ordinaryCharacters = 0;
  for (const character of text) {
    if (/[^\u0000-\u024f]/u.test(character)) denseCharacters += 1;
    else ordinaryCharacters += 1;
  }
  return denseCharacters + Math.ceil(ordinaryCharacters / 4);
}

export function getDirectPromptTokenBudget(
  usage: PromptContextBudget | null | undefined,
): number | null {
  if (!usage || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return null;
  const used = usage.tokens ?? (
    usage.percent !== null && usage.percent !== undefined && Number.isFinite(usage.percent)
      ? Math.ceil(usage.contextWindow * Math.max(0, usage.percent) / 100)
      : 0
  );
  const outputReserve = Math.max(8_192, Math.min(32_768, Math.ceil(usage.contextWindow * 0.15)));
  return Math.max(1_024, usage.contextWindow - used - outputReserve);
}

export function shouldMaterializeDirectPrompt(
  text: string,
  usage: PromptContextBudget | null | undefined,
): boolean {
  if (new TextEncoder().encode(text).byteLength > DIRECT_PROMPT_TRANSPORT_BYTES) return true;
  const tokenBudget = getDirectPromptTokenBudget(usage);
  return tokenBudget !== null && estimatePromptTokens(text) > tokenBudget;
}
