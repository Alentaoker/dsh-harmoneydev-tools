// Shared by browser admission, HTTP capabilities, workers and unpackers.
// Keep per-page, per-line and worker memory budgets independent of file size.
export const TEXT_BYTES = 1024 ** 3;
export const PACKAGE_BYTES = 2 * 1024 ** 3;
export const EXPANDED_BYTES = 8 * 1024 ** 3;
export const MAX_PACKAGE_ENTRIES = 10000;
export const importLimitLabel = '明文每份最多 1 GiB，ZIP / GZ / RAR 每份最多 2 GiB';
export const expandedLimitLabel = '展开内容超过限制：单份文本 1 GiB / 单份内层压缩包 2 GiB / 累计 8 GiB';
