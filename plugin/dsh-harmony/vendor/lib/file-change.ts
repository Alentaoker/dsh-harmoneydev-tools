import type { ToolCallContent, ToolResultMessage } from "./types";

export type FileChangeKind = "created" | "updated" | "unchanged";
export type FileChangeStatus = "running" | "completed" | "failed";

export interface FileChangeInfo {
  path: string;
  patch: string | null;
  added: number;
  removed: number;
  kind: FileChangeKind;
  status: FileChangeStatus;
  unavailableReason?: string;
}

export function getFileChangeInfo(
  block: ToolCallContent,
  result?: ToolResultMessage,
): FileChangeInfo | null {
  const details = isRecord(result?.details) ? result.details : {};
  const path = firstNonEmptyString(block.input.path, block.input.file_path, details.path);
  const patch = unifiedPatch(details.patch) ?? unifiedPatch(details.diff) ?? null;
  const isKnownFileMutation = block.toolName === "edit" || block.toolName === "write";

  if (!path || (!isKnownFileMutation && !patch)) return null;

  const stats = countPatchLines(patch);
  const status = !result ? "running" : result.isError ? "failed" : "completed";
  const declaredKind = details.changeKind;
  const kind: FileChangeKind = declaredKind === "created" || declaredKind === "updated" || declaredKind === "unchanged"
    ? declaredKind
    : patch === ""
      ? "unchanged"
      : block.toolName === "write" && details.created === true
        ? "created"
        : "updated";

  return {
    path,
    patch,
    added: stats.added,
    removed: stats.removed,
    kind,
    status,
    ...(typeof details.fileChangeUnavailable === "string"
      ? { unavailableReason: details.fileChangeUnavailable }
      : {}),
  };
}

export function countPatchLines(patch: string | null): { added: number; removed: number } {
  if (!patch) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const line of patch.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function unifiedPatch(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return /^--- .+\n\+\+\+ /m.test(value.replace(/\r\n?/g, "\n")) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
