export const REVIEW_LIST_PAGE_SIZE = 60;

export interface ReviewListWindow {
  startIndex: number;
  endIndex: number;
  before: number;
  after: number;
}

export function getReviewListWindow(
  totalCount: number,
  selectedIndex: number,
  pageSize = REVIEW_LIST_PAGE_SIZE,
): ReviewListWindow {
  const total = Math.max(0, Math.floor(totalCount));
  if (total === 0) return { startIndex: 0, endIndex: 0, before: 0, after: 0 };

  const size = Math.max(1, Math.floor(pageSize));
  const selected = Math.min(total - 1, Math.max(0, Math.floor(selectedIndex)));
  const startIndex = Math.floor(selected / size) * size;
  const endIndex = Math.min(total, startIndex + size);
  return {
    startIndex,
    endIndex,
    before: startIndex,
    after: total - endIndex,
  };
}
