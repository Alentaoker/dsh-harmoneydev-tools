export const LIVE_OUTPUT_AUTO_SCROLL_STORAGE_KEY = "piora-live-output-auto-scroll:v1";
export const DEFAULT_LIVE_OUTPUT_AUTO_SCROLL = true;

export function parseStoredLiveOutputAutoScroll(value: string | null): boolean {
  if (value === "false") return false;
  if (value === "true") return true;
  return DEFAULT_LIVE_OUTPUT_AUTO_SCROLL;
}

export function serializeLiveOutputAutoScroll(enabled: boolean): string {
  return String(enabled);
}
