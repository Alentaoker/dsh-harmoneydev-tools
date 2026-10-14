export type ReviewNavigationKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

export function getReviewNavigationIndex(
  currentIndex: number,
  key: string,
  itemCount: number,
): number | null {
  if (itemCount <= 0) return null;
  const current = Math.min(Math.max(currentIndex, 0), itemCount - 1);
  if (key === "ArrowDown") return Math.min(itemCount - 1, current + 1);
  if (key === "ArrowUp") return Math.max(0, current - 1);
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  return null;
}

export function isCommitKeyboardShortcut(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  return event.key === "Enter"
    && (event.ctrlKey || event.metaKey)
    && !event.altKey
    && !event.shiftKey;
}
