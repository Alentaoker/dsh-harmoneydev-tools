import type { CompanionRuntimeState } from "./companion-runtime";
import type { CompanionPreferences } from "./companion-store";

export function mergeCompanionRuntimePreferences(
  current: CompanionPreferences,
  runtime: CompanionRuntimeState,
): CompanionPreferences {
  const interactionModel = runtime.settings.interactionModel;
  const sameModel = current.interactionModel?.provider === interactionModel?.provider
    && current.interactionModel?.modelId === interactionModel?.modelId;
  if (sameModel && current.shareWorkContext === runtime.settings.shareWorkContext) return current;
  return { ...current, interactionModel, shareWorkContext: runtime.settings.shareWorkContext };
}
