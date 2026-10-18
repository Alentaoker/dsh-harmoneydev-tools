/**
 * Keyboard and filtering rules for the log search boxes — standalone fallback.
 *
 * The canonical implementation lives in `plugin/dsh-e2e/src/log-search-menu.mjs`
 * and is used whenever the paired source is present (the normal build). This copy
 * exists only so a standalone build of this plugin keeps working, and
 * `tests/log-search-menu.test.mjs` compares the two on a fixed case table so they
 * cannot drift apart.
 */
export type LogSearchKeyAction = "close" | "up" | "down" | "apply" | null;

export interface LogSearchMenuState {
  open: boolean;
  cursor: number;
  count: number;
  selected: boolean;
}

interface KeyEventLike {
  key: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}

export function isComposingKey(event: KeyEventLike): boolean {
  const native = event?.nativeEvent;
  if (native?.isComposing === true || native?.keyCode === 229) return true;
  return event?.isComposing === true || event?.keyCode === 229;
}

export function historyKeyAction(event: KeyEventLike, state: LogSearchMenuState): LogSearchKeyAction {
  if (isComposingKey(event)) return null;
  if (!state.open) return null;
  if (event.key === "Escape") return "close";
  if (event.key === "ArrowUp") return "up";
  if (event.key === "ArrowDown") return "down";
  if (event.key === "Enter" && !event.shiftKey && state.selected && state.count > 0) return "apply";
  return null;
}

export function nextCursor(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  const base = Number.isFinite(current) ? current : 0;
  return ((base + delta) % count + count) % count;
}

export function filterHistoryEntries<T extends { query: string }>(entries: T[], value: string): T[] {
  const text = String(value ?? "").trim().toLocaleLowerCase();
  if (!text) return entries;
  return entries.filter(entry => String(entry.query).toLocaleLowerCase().includes(text));
}
