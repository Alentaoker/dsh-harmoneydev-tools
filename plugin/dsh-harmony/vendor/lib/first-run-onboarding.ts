export const FIRST_RUN_ONBOARDING_STORAGE_KEY = "piora-first-run-onboarding:v1";
export const FIRST_RUN_ONBOARDING_VERSION = 1;

export const FIRST_RUN_ONBOARDING_STEPS = ["model", "project", "chat"] as const;

export type FirstRunOnboardingStep = (typeof FIRST_RUN_ONBOARDING_STEPS)[number];
export type FirstRunOnboardingStatus = "active" | "completed" | "dismissed";

export interface FirstRunOnboardingState {
  version: typeof FIRST_RUN_ONBOARDING_VERSION;
  status: FirstRunOnboardingStatus;
  step: FirstRunOnboardingStep;
}

export interface StorageReader {
  getItem(key: string): string | null;
}

export interface StorageWriter extends StorageReader {
  setItem(key: string, value: string): void;
}

export function createFirstRunOnboardingState(
  status: FirstRunOnboardingStatus = "active",
  step: FirstRunOnboardingStep = "model",
): FirstRunOnboardingState {
  return { version: FIRST_RUN_ONBOARDING_VERSION, status, step };
}

export function parseFirstRunOnboardingState(raw: string | null): FirstRunOnboardingState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FirstRunOnboardingState>;
    if (parsed.version !== FIRST_RUN_ONBOARDING_VERSION) return null;
    if (parsed.status !== "active" && parsed.status !== "completed" && parsed.status !== "dismissed") return null;
    if (!FIRST_RUN_ONBOARDING_STEPS.includes(parsed.step as FirstRunOnboardingStep)) return null;
    return parsed as FirstRunOnboardingState;
  } catch {
    return null;
  }
}

export function readFirstRunOnboardingState(storage: StorageReader): FirstRunOnboardingState | null {
  try {
    return parseFirstRunOnboardingState(storage.getItem(FIRST_RUN_ONBOARDING_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeFirstRunOnboardingState(
  storage: StorageWriter,
  state: FirstRunOnboardingState,
): FirstRunOnboardingState {
  try {
    storage.setItem(FIRST_RUN_ONBOARDING_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The walkthrough remains usable for this page when storage is blocked.
  }
  return state;
}

export function resolveInitialFirstRunOnboardingState(
  stored: FirstRunOnboardingState | null,
  sessionCount: number,
): FirstRunOnboardingState {
  if (stored) return stored;
  // Installing the walkthrough in an existing profile must not suddenly
  // interrupt that user. Existing sessions are a reliable, private signal
  // that Piora has already been used on this profile.
  return createFirstRunOnboardingState(sessionCount > 0 ? "dismissed" : "active");
}

export function nextFirstRunOnboardingStep(step: FirstRunOnboardingStep): FirstRunOnboardingStep {
  const index = FIRST_RUN_ONBOARDING_STEPS.indexOf(step);
  return FIRST_RUN_ONBOARDING_STEPS[Math.min(index + 1, FIRST_RUN_ONBOARDING_STEPS.length - 1)];
}
