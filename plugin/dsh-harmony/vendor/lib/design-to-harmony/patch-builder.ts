import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DesignToHarmonyError } from "./errors";
import { getDesignManagedStateStore, type DesignManagedStateStore } from "./managed-state-store";
import { getDesignPreviewWorkspace, type DesignPreviewWorkspace, validatePreviewRelativePath } from "./preview-workspace";
import { stableDesignHash } from "./stable-json";
import type {
  DesignAnalysisRun,
  DesignManagedFileRecord,
  DesignPatchConflictCode,
  DesignPatchFile,
  DesignPatchSet,
  GeneratedArtifactManifest,
} from "./types";

const MAX_TARGET_BYTES = 2 * 1024 * 1024;

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function ensureWithin(root: string, target: string): void {
  const child = relative(resolve(root), resolve(target));
  if (child && !child.startsWith("..") && !isAbsolute(child)) return;
  throw new DesignToHarmonyError("PATCH_CONFLICT", "A generated target escaped the selected project", { status: 409, stage: "review" });
}

export function resolveDesignPatchTarget(projectRoot: string, relativePathValue: string): string {
  const relativePath = validatePreviewRelativePath(relativePathValue);
  const target = join(resolve(projectRoot), ...relativePath.split("/"));
  ensureWithin(projectRoot, target);
  return target;
}

function assertSafeTargetAncestors(projectRoot: string, targetPath: string): void {
  const root = resolve(projectRoot);
  const rootReal = realpathSync(root);
  let cursor = dirname(targetPath);
  const visited: string[] = [];
  while (cursor !== root && cursor !== dirname(cursor)) {
    visited.push(cursor);
    cursor = dirname(cursor);
  }
  if (cursor !== root) throw new DesignToHarmonyError("PATCH_CONFLICT", "Generated target is outside the selected project", { status: 409, stage: "review" });
  for (const candidate of visited.reverse()) {
    if (!existsSync(candidate)) break;
    const details = lstatSync(candidate);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new DesignToHarmonyError("PATCH_CONFLICT", "A generated target has an unsafe parent path", {
        status: 409,
        stage: "review",
        details: { target: relative(root, candidate).replace(/\\/g, "/") },
      });
    }
    ensureWithin(rootReal, realpathSync(candidate));
  }
}

function splitLines(content: string): string[] {
  if (!content) return [];
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function patchLine(value: string): string {
  return value.replace(/\r$/, "");
}

export function buildDesignUnifiedPatch(relativePath: string, currentContent: string, previewContent: string): {
  patch: string;
  additions: number;
  deletions: number;
} {
  if (currentContent === previewContent) return { patch: "", additions: 0, deletions: 0 };
  const before = splitLines(currentContent);
  const after = splitLines(previewContent);
  let commonPrefix = 0;
  while (commonPrefix < before.length && commonPrefix < after.length && before[commonPrefix] === after[commonPrefix]) commonPrefix += 1;
  let commonSuffix = 0;
  while (commonSuffix < before.length - commonPrefix
    && commonSuffix < after.length - commonPrefix
    && before[before.length - 1 - commonSuffix] === after[after.length - 1 - commonSuffix]) commonSuffix += 1;
  const contextBefore = Math.min(3, commonPrefix);
  const contextAfter = Math.min(3, commonSuffix);
  const oldStartIndex = commonPrefix - contextBefore;
  const newStartIndex = commonPrefix - contextBefore;
  const removed = before.slice(commonPrefix, before.length - commonSuffix);
  const added = after.slice(commonPrefix, after.length - commonSuffix);
  const leading = before.slice(oldStartIndex, commonPrefix);
  const trailing = before.slice(before.length - commonSuffix, before.length - commonSuffix + contextAfter);
  const oldCount = leading.length + removed.length + trailing.length;
  const newCount = leading.length + added.length + trailing.length;
  const oldStart = oldCount === 0 ? 0 : oldStartIndex + 1;
  const newStart = newCount === 0 ? 0 : newStartIndex + 1;
  const lines = [
    `diff --git a/${relativePath} b/${relativePath}`,
    currentContent ? `--- a/${relativePath}` : "--- /dev/null",
    `+++ b/${relativePath}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...leading.map((line) => ` ${patchLine(line)}`),
    ...removed.map((line) => `-${patchLine(line)}`),
    ...added.map((line) => `+${patchLine(line)}`),
    ...trailing.map((line) => ` ${patchLine(line)}`),
    "",
  ];
  return { patch: lines.join("\n"), additions: added.length, deletions: removed.length };
}

type CurrentTarget = {
  exists: boolean;
  content?: string;
  binary: boolean;
  sha256?: string;
  bytes?: number;
  conflictCode?: DesignPatchConflictCode;
  conflictMessage?: string;
};

function readCurrentTarget(projectRoot: string, targetPath: string): CurrentTarget {
  assertSafeTargetAncestors(projectRoot, targetPath);
  if (!existsSync(targetPath)) return { exists: false, content: "", binary: false };
  try {
    const details = lstatSync(targetPath);
    if (details.isSymbolicLink() || !details.isFile()) {
      return { exists: true, binary: false, conflictCode: "non_regular_target", conflictMessage: "The target is not a regular file and cannot be replaced." };
    }
    if (details.size > MAX_TARGET_BYTES) {
      return { exists: true, binary: false, bytes: details.size, conflictCode: "target_too_large", conflictMessage: "The existing target exceeds the safe review limit." };
    }
    const bytes = readFileSync(targetPath);
    if (bytes.byteLength > MAX_TARGET_BYTES) {
      return { exists: true, binary: false, bytes: bytes.byteLength, conflictCode: "target_too_large", conflictMessage: "The existing target exceeds the safe review limit." };
    }
    if (!isUtf8(bytes) || bytes.includes(0)) {
      return { exists: true, binary: true, bytes: bytes.byteLength, sha256: digest(bytes) };
    }
    return { exists: true, content: bytes.toString("utf8"), binary: false, bytes: bytes.byteLength, sha256: digest(bytes) };
  } catch (error) {
    if (error instanceof DesignToHarmonyError) throw error;
    return {
      exists: true,
      binary: false,
      conflictCode: "non_regular_target",
      conflictMessage: error instanceof Error ? error.message : "The existing target could not be read safely.",
    };
  }
}

function classify(input: {
  current: CurrentTarget;
  managed?: DesignManagedFileRecord;
  previewSha256: string;
}): Pick<DesignPatchFile, "change" | "conflictCode" | "conflictMessage" | "overwriteAllowed" | "managementMode"> {
  const { current, managed, previewSha256 } = input;
  const managementMode = managed?.mode ?? "unmanaged";
  if (current.conflictCode) {
    return { change: "conflict", conflictCode: current.conflictCode, conflictMessage: current.conflictMessage, overwriteAllowed: false, managementMode };
  }
  if (current.exists && current.sha256 === previewSha256) {
    return { change: "unchanged", overwriteAllowed: false, managementMode };
  }
  if (managed?.mode === "detached") {
    return { change: "conflict", conflictCode: "detached_file", conflictMessage: "This file is detached from design synchronization.", overwriteAllowed: false, managementMode };
  }
  if (managed && (!current.exists || current.sha256 !== managed.appliedSha256)) {
    return { change: "conflict", conflictCode: "managed_modified", conflictMessage: current.exists ? "This managed file was modified after the last design apply." : "This managed file was deleted after the last design apply.", overwriteAllowed: true, managementMode };
  }
  if (!current.exists) return { change: "add", overwriteAllowed: false, managementMode };
  if (!managed) {
    return { change: "conflict", conflictCode: "unmanaged_existing", conflictMessage: "An existing user-owned file occupies this generated path.", overwriteAllowed: true, managementMode };
  }
  return { change: "modify", overwriteAllowed: false, managementMode };
}

export function buildDesignPatchSet(input: {
  run: DesignAnalysisRun;
  preview: GeneratedArtifactManifest;
  workspace?: DesignPreviewWorkspace;
  managedStore?: DesignManagedStateStore;
}): DesignPatchSet {
  const { run, preview } = input;
  if (!run.plan || !run.preview || run.preview.id !== preview.id || preview.runId !== run.id || preview.planId !== run.plan.id) {
    throw new DesignToHarmonyError("PREVIEW_CONFLICT", "The preview no longer matches this design run", { status: 409, stage: "review" });
  }
  const workspace = input.workspace ?? getDesignPreviewWorkspace();
  const managedState = (input.managedStore ?? getDesignManagedStateStore()).get(run.projectRoot);
  const managedByPath = new Map(managedState.files.map((record) => [record.relativePath, record]));
  const files = preview.artifacts.map((artifact): DesignPatchFile => {
    const previewFile = workspace.readFile(run.id, preview.id, artifact.relativePath);
    const targetPath = resolveDesignPatchTarget(run.projectRoot, artifact.relativePath);
    const current = readCurrentTarget(run.projectRoot, targetPath);
    const managed = managedByPath.get(artifact.relativePath);
    const classification = classify({ current, managed, previewSha256: artifact.sha256 });
    const binary = previewFile.encoding === "base64";
    const textMismatch = current.binary && !binary;
    const safeClassification = textMismatch
      ? { change: "conflict" as const, conflictCode: "non_text_target" as const, conflictMessage: "A generated text file would replace a non-text target.", overwriteAllowed: false, managementMode: classification.managementMode }
      : classification;
    const diff = current.conflictCode || textMismatch
      ? { patch: "", additions: 0, deletions: 0 }
      : binary
        ? { patch: current.sha256 === artifact.sha256 ? "" : `Binary files a/${artifact.relativePath} and b/${artifact.relativePath} differ\n`, additions: 0, deletions: 0 }
        : buildDesignUnifiedPatch(artifact.relativePath, current.content ?? "", previewFile.content);
    return {
      relativePath: artifact.relativePath,
      targetPath,
      kind: artifact.kind,
      mediaType: artifact.mediaType,
      ...safeClassification,
      currentExists: current.exists,
      ...(current.sha256 ? { currentSha256: current.sha256 } : {}),
      ...(current.bytes !== undefined ? { currentBytes: current.bytes } : {}),
      previewSha256: artifact.sha256,
      previewBytes: artifact.bytes,
      additions: diff.additions,
      deletions: diff.deletions,
      patch: diff.patch,
      binary,
      sourceNodeIds: artifact.sourceNodeIds,
    };
  }).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const stats = {
    additions: files.filter((file) => file.change === "add").length,
    modifications: files.filter((file) => file.change === "modify").length,
    unchanged: files.filter((file) => file.change === "unchanged").length,
    conflicts: files.filter((file) => file.change === "conflict").length,
    linesAdded: files.reduce((total, file) => total + file.additions, 0),
    linesDeleted: files.reduce((total, file) => total + file.deletions, 0),
  };
  const hashBase = {
    schemaVersion: 1 as const,
    runId: run.id,
    previewId: preview.id,
    planId: preview.planId,
    projectRoot: resolve(run.projectRoot),
    managedStateRevision: managedState.revision,
    files,
    stats,
  };
  const hash = stableDesignHash(hashBase);
  const actionable = files.some((file) => file.change === "add" || file.change === "modify" || (file.change === "unchanged" && file.managementMode === "unmanaged"));
  return {
    ...hashBase,
    id: `patch_${hash.slice(0, 20)}`,
    runRevision: run.revision,
    canApply: stats.conflicts === 0 && actionable,
    hash,
  };
}
