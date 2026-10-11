export const TREE_INITIAL_RENDER_COUNT = 200;
export const TREE_RENDER_STEP = 200;

export interface TreeRenderWindow {
  endIndex: number;
  remaining: number;
}

export function getTreeRenderWindow(totalCount: number, requestedCount: number): TreeRenderWindow {
  const total = Math.max(0, Math.floor(totalCount));
  const requested = Math.max(TREE_INITIAL_RENDER_COUNT, Math.floor(requestedCount));
  const endIndex = Math.min(total, requested);
  return { endIndex, remaining: Math.max(0, total - endIndex) };
}

export function getNextTreeRenderCount(currentCount: number, totalCount: number): number {
  const total = Math.max(0, Math.floor(totalCount));
  return Math.min(total, Math.max(TREE_INITIAL_RENDER_COUNT, Math.floor(currentCount)) + TREE_RENDER_STEP);
}
