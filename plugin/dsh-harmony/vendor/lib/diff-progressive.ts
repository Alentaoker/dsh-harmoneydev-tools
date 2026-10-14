export const DIFF_PROGRESSIVE_THRESHOLD = 800;
export const DIFF_RENDER_BATCH = 400;

export interface DiffRenderWindow {
  endIndex: number;
  remaining: number;
}

export function getDiffRenderWindow(totalLines: number, requestedLines: number): DiffRenderWindow {
  const total = Math.max(0, Math.floor(totalLines));
  const requested = Math.max(DIFF_RENDER_BATCH, Math.floor(requestedLines));
  const endIndex = Math.min(total, requested);
  return { endIndex, remaining: Math.max(0, total - endIndex) };
}

export function getNextDiffRenderCount(currentLines: number, totalLines: number): number {
  return Math.min(
    Math.max(0, Math.floor(totalLines)),
    Math.max(DIFF_RENDER_BATCH, Math.floor(currentLines)) + DIFF_RENDER_BATCH,
  );
}
