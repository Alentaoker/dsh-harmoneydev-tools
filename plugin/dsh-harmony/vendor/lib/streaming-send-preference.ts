export type StreamingSendBehavior = "steer" | "followup";

export interface StreamingSendPreference {
  schemaVersion: 1;
  enabled: boolean;
  behavior: StreamingSendBehavior;
}

export const STREAMING_SEND_PREFERENCE_STORAGE_KEY = "piora-streaming-send-preference:v1";
export const DEFAULT_STREAMING_SEND_PREFERENCE: Readonly<StreamingSendPreference> = Object.freeze({
  schemaVersion: 1,
  enabled: false,
  behavior: "steer",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeStreamingSendPreference(value: unknown): StreamingSendPreference {
  if (!isRecord(value)) return { ...DEFAULT_STREAMING_SEND_PREFERENCE };
  return {
    schemaVersion: 1,
    enabled: typeof value.enabled === "boolean" ? value.enabled : false,
    behavior: value.behavior === "followup" || value.behavior === "steer" ? value.behavior : "steer",
  };
}

export function parseStoredStreamingSendPreference(value: string | null): StreamingSendPreference {
  if (!value) return { ...DEFAULT_STREAMING_SEND_PREFERENCE };
  try {
    return normalizeStreamingSendPreference(JSON.parse(value) as unknown);
  } catch {
    return { ...DEFAULT_STREAMING_SEND_PREFERENCE };
  }
}

export function serializeStreamingSendPreference(preference: StreamingSendPreference): string {
  return JSON.stringify(normalizeStreamingSendPreference(preference));
}
