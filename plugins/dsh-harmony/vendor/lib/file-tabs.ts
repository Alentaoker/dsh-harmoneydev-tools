export interface FileTabState {
  id: string;
  isDirty?: boolean;
}

export const MAX_CLOSED_FILE_TABS = 12;

export function moveFileTab<T extends FileTabState>(tabs: readonly T[], tabId: string, targetIndex: number): T[] {
  const sourceIndex = tabs.findIndex((tab) => tab.id === tabId);
  if (sourceIndex < 0 || tabs.length < 2) return [...tabs];
  const boundedTarget = Math.max(0, Math.min(Math.trunc(targetIndex), tabs.length - 1));
  if (sourceIndex === boundedTarget) return [...tabs];
  const next = [...tabs];
  const [tab] = next.splice(sourceIndex, 1);
  next.splice(boundedTarget, 0, tab);
  return next;
}

export function tabsAfter<T extends FileTabState>(tabs: readonly T[], tabId: string): T[] {
  const index = tabs.findIndex((tab) => tab.id === tabId);
  return index < 0 ? [] : tabs.slice(index + 1);
}

export function tabsExcept<T extends FileTabState>(tabs: readonly T[], tabId: string): T[] {
  return tabs.filter((tab) => tab.id !== tabId);
}

export function rememberClosedFileTabs<T extends FileTabState>(
  history: readonly T[],
  closedTabs: readonly T[],
  limit = MAX_CLOSED_FILE_TABS,
): T[] {
  if (limit <= 0) return [];
  const closed = [...closedTabs].reverse().map((tab) => ({ ...tab, isDirty: false }));
  const closedIds = new Set(closed.map((tab) => tab.id));
  const deduped = [...closed, ...history.filter((tab) => !closedIds.has(tab.id))];
  return deduped.slice(0, limit);
}

export function findReopenableFileTab<T extends FileTabState>(history: readonly T[], openTabs: readonly T[]): T | null {
  const openIds = new Set(openTabs.map((tab) => tab.id));
  return history.find((tab) => !openIds.has(tab.id)) ?? null;
}
