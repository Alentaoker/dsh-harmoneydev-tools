import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { designToHarmonyDataRoot } from "./data-root";
import { DesignToHarmonyError } from "./errors";
import { getDesignManagedStateStore, type DesignManagedStateStore } from "./managed-state-store";
import { buildDesignPatchSet, resolveDesignPatchTarget } from "./patch-builder";
import { getDesignPreviewWorkspace, type DesignPreviewWorkspace } from "./preview-workspace";
import { stableDesignHash } from "./stable-json";
import type {
  DesignAnalysisRun,
  DesignApplyRecord,
  DesignManagedFileRecord,
  DesignPatchFile,
  DesignPatchSet,
  GeneratedArtifactManifest,
} from "./types";

const TRANSACTION_PATTERN = /^apply_[a-f0-9]{20}$/;
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const MAX_APPLY_HASH_BYTES = 2 * 1024 * 1024;

type JournalState = "prepared" | "committing" | "files_committed";

interface ApplyJournalOperation {
  relativePath: string;
  targetPath: string;
  temporaryPath: string;
  backupPath: string;
  currentExists: boolean;
  currentSha256?: string;
  previewSha256: string;
  mode: number;
  committed: boolean;
}

interface ApplyJournal {
  schemaVersion: 1;
  id: string;
  projectRoot: string;
  state: JournalState;
  expectedManagedRevision: number;
  createdDirectories: string[];
  operations: ApplyJournalOperation[];
  nextManagedFiles: DesignManagedFileRecord[];
}

type ApplyServiceOptions = {
  dataRoot?: string;
  workspace?: DesignPreviewWorkspace;
  managedStore?: DesignManagedStateStore;
  afterCommitForTests?: ((relativePath: string, index: number) => void) | undefined;
};

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function comparablePath(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathsEqual(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function assertRealDirectoryWithinProject(projectRoot: string, directory: string): void {
  const rootReal = realpathSync(projectRoot);
  const directoryReal = realpathSync(directory);
  const child = relative(rootReal, directoryReal);
  if (child === "" || (!child.startsWith("..") && !/^[/\\]/.test(child))) return;
  throw new DesignToHarmonyError("PATCH_CONFLICT", "A generated target directory resolves outside the selected project", { status: 409, stage: "apply" });
}

function removeFileIfPresent(filePath: string): boolean {
  try {
    unlinkSync(filePath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function targetMatches(file: DesignPatchFile): boolean {
  if (!existsSync(file.targetPath)) return !file.currentExists;
  if (!file.currentExists || !file.currentSha256) return false;
  try {
    const details = lstatSync(file.targetPath);
    return details.isFile()
      && !details.isSymbolicLink()
      && details.size <= MAX_APPLY_HASH_BYTES
      && digest(readFileSync(file.targetPath)) === file.currentSha256;
  } catch {
    return false;
  }
}

function transactionId(): string {
  return `apply_${randomBytes(16).toString("hex").slice(0, 20)}`;
}

function isJournal(value: unknown): value is ApplyJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const journal = value as Partial<ApplyJournal>;
  return journal.schemaVersion === 1
    && typeof journal.id === "string"
    && TRANSACTION_PATTERN.test(journal.id)
    && typeof journal.projectRoot === "string"
    && ["prepared", "committing", "files_committed"].includes(journal.state ?? "")
    && Number.isSafeInteger(journal.expectedManagedRevision)
    && Array.isArray(journal.createdDirectories)
    && journal.createdDirectories.every((path) => typeof path === "string")
    && Array.isArray(journal.operations)
    && journal.operations.every((operation) => operation
      && typeof operation.relativePath === "string"
      && typeof operation.targetPath === "string"
      && typeof operation.temporaryPath === "string"
      && typeof operation.backupPath === "string"
      && typeof operation.currentExists === "boolean"
      && typeof operation.previewSha256 === "string"
      && typeof operation.mode === "number"
      && typeof operation.committed === "boolean")
    && Array.isArray(journal.nextManagedFiles);
}

export class DesignProjectApplyService {
  readonly transactionRoot: string;
  readonly workspace: DesignPreviewWorkspace;
  readonly managedStore: DesignManagedStateStore;
  private readonly afterCommitForTests?: (relativePath: string, index: number) => void;

  constructor(options: ApplyServiceOptions = {}) {
    const dataRoot = options.dataRoot ?? designToHarmonyDataRoot();
    this.transactionRoot = join(resolve(dataRoot), "apply-transactions");
    this.workspace = options.workspace ?? getDesignPreviewWorkspace();
    this.managedStore = options.managedStore ?? getDesignManagedStateStore();
    this.afterCommitForTests = options.afterCommitForTests;
  }

  private transactionDirectory(id: string): string {
    if (!TRANSACTION_PATTERN.test(id)) throw new DesignToHarmonyError("APPLY_RECOVERY_REQUIRED", "Invalid design apply transaction", { status: 409, stage: "apply" });
    return join(this.transactionRoot, id);
  }

  private journalPath(id: string): string {
    return join(this.transactionDirectory(id), "journal.json");
  }

  private writeJournal(journal: ApplyJournal): void {
    const contents = `${JSON.stringify(journal, null, 2)}\n`;
    if (Buffer.byteLength(contents, "utf8") > MAX_JOURNAL_BYTES) {
      throw new DesignToHarmonyError("APPLY_FAILED", "Design apply transaction is too large", { status: 413, stage: "apply" });
    }
    mkdirSync(this.transactionDirectory(journal.id), { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(this.journalPath(journal.id), contents);
  }

  private readJournal(id: string): ApplyJournal | undefined {
    const path = this.journalPath(id);
    try {
      if (!existsSync(path) || statSync(path).size > MAX_JOURNAL_BYTES) return undefined;
      const journal = JSON.parse(readFileSync(path, "utf8"));
      return isJournal(journal) ? journal : undefined;
    } catch {
      return undefined;
    }
  }

  private validateOperation(journal: ApplyJournal, operation: ApplyJournalOperation): void {
    const expectedTarget = resolveDesignPatchTarget(journal.projectRoot, operation.relativePath);
    if (!pathsEqual(expectedTarget, operation.targetPath)) throw new DesignToHarmonyError("APPLY_RECOVERY_REQUIRED", "Apply journal target no longer matches the project", { status: 409, stage: "apply" });
    const directory = dirname(expectedTarget);
    const tempPrefix = `.piora-design-apply-${journal.id}-`;
    const backupPrefix = `.piora-design-backup-${journal.id}-`;
    if (!pathsEqual(dirname(operation.temporaryPath), directory)
      || !pathsEqual(dirname(operation.backupPath), directory)
      || !basename(operation.temporaryPath).startsWith(tempPrefix)
      || !basename(operation.backupPath).startsWith(backupPrefix)) {
      throw new DesignToHarmonyError("APPLY_RECOVERY_REQUIRED", "Apply journal contains an unsafe temporary path", { status: 409, stage: "apply" });
    }
    if (!existsSync(directory)) throw new DesignToHarmonyError("APPLY_RECOVERY_REQUIRED", "An apply target directory disappeared before recovery", { status: 409, retryable: true, stage: "apply" });
    const directoryDetails = lstatSync(directory);
    if (directoryDetails.isSymbolicLink() || !directoryDetails.isDirectory()) {
      throw new DesignToHarmonyError("APPLY_RECOVERY_REQUIRED", "An apply target directory is no longer safe", { status: 409, retryable: true, stage: "apply" });
    }
    assertRealDirectoryWithinProject(journal.projectRoot, directory);
  }

  private validateCreatedDirectories(journal: ApplyJournal): void {
    const root = resolve(journal.projectRoot);
    for (const directory of journal.createdDirectories) {
      const resolvedDirectory = resolve(directory);
      const child = relative(root, resolvedDirectory);
      const belongsToOperation = journal.operations.some((operation) => {
        const targetChild = relative(resolvedDirectory, dirname(operation.targetPath));
        return targetChild === "" || (!targetChild.startsWith("..") && !/^[/\\]/.test(targetChild));
      });
      if (!child || child.startsWith("..") || /^[/\\]/.test(child) || !belongsToOperation) {
        throw new DesignToHarmonyError("APPLY_RECOVERY_REQUIRED", "Apply journal contains an unsafe created directory", { status: 409, stage: "apply" });
      }
    }
  }

  private cleanupCommitted(journal: ApplyJournal): boolean {
    let complete = true;
    for (const operation of journal.operations) {
      complete = removeFileIfPresent(operation.temporaryPath) && complete;
      complete = removeFileIfPresent(operation.backupPath) && complete;
    }
    if (complete) {
      removeFileIfPresent(this.journalPath(journal.id));
      try { rmdirSync(this.transactionDirectory(journal.id)); } catch { /* retry on the next recovery pass */ }
    }
    return complete;
  }

  private rollback(journal: ApplyJournal): void {
    this.validateCreatedDirectories(journal);
    for (const operation of [...journal.operations].reverse()) {
      this.validateOperation(journal, operation);
      const backupExists = existsSync(operation.backupPath);
      if (existsSync(operation.targetPath)) {
        const details = lstatSync(operation.targetPath);
        const currentHash = details.isFile() && !details.isSymbolicLink() ? digest(readFileSync(operation.targetPath)) : "";
        const targetIsAppliedOutput = currentHash === operation.previewSha256;
        const untouchedOriginal = !operation.committed && !backupExists && operation.currentExists && currentHash === operation.currentSha256;
        if (!targetIsAppliedOutput && !untouchedOriginal) {
          throw new DesignToHarmonyError("APPLY_RECOVERY_REQUIRED", "A file changed while the design apply was being rolled back", {
            status: 409,
            retryable: true,
            stage: "apply",
            details: { relativePath: operation.relativePath },
          });
        }
        if (targetIsAppliedOutput) unlinkSync(operation.targetPath);
      }
      if (backupExists) renameSync(operation.backupPath, operation.targetPath);
      removeFileIfPresent(operation.temporaryPath);
    }
    for (const directory of [...journal.createdDirectories].sort((left, right) => right.length - left.length)) {
      try { rmdirSync(directory); } catch { /* only remove directories that are still empty */ }
    }
    removeFileIfPresent(this.journalPath(journal.id));
    try { rmdirSync(this.transactionDirectory(journal.id)); } catch { /* leave a harmless empty recovery directory */ }
  }

  async recover(projectRoot: string): Promise<void> {
    if (!existsSync(this.transactionRoot)) return;
    const entries = readdirSync(this.transactionRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && TRANSACTION_PATTERN.test(entry.name)).slice(0, 100);
    for (const entry of entries) {
      const journal = this.readJournal(entry.name);
      if (!journal || !pathsEqual(journal.projectRoot, projectRoot)) continue;
      this.validateCreatedDirectories(journal);
      for (const operation of journal.operations) this.validateOperation(journal, operation);
      if (journal.state === "files_committed") {
        const current = this.managedStore.get(projectRoot);
        if (current.revision === journal.expectedManagedRevision) {
          await this.managedStore.replace(projectRoot, journal.expectedManagedRevision, journal.nextManagedFiles);
        } else if (current.revision !== journal.expectedManagedRevision + 1
          || stableDesignHash(current.files) !== stableDesignHash(journal.nextManagedFiles)) {
          throw new DesignToHarmonyError("APPLY_RECOVERY_REQUIRED", "Managed state changed before an interrupted apply could be finalized", { status: 409, retryable: true, stage: "apply" });
        }
        this.cleanupCommitted(journal);
      } else {
        this.rollback(journal);
      }
    }
  }

  private nextManagedFiles(run: DesignAnalysisRun, preview: GeneratedArtifactManifest, patch: DesignPatchSet, appliedAt: string): DesignManagedFileRecord[] {
    const current = this.managedStore.get(run.projectRoot);
    const byPath = new Map(current.files.map((record) => [record.relativePath, record]));
    const patchByPath = new Map(patch.files.map((file) => [file.relativePath, file]));
    for (const artifact of preview.artifacts) {
      const patchFile = patchByPath.get(artifact.relativePath);
      if (!patchFile || patchFile.managementMode === "detached") continue;
      byPath.set(artifact.relativePath, {
        relativePath: artifact.relativePath,
        mode: "managed",
        sourceImportId: run.importId,
        sourceVersion: run.sourceVersion,
        planId: preview.planId,
        previewId: preview.id,
        generatorVersion: preview.generatorVersion,
        sourceNodeIds: artifact.sourceNodeIds,
        appliedSha256: artifact.sha256,
        appliedAt,
      });
    }
    return [...byPath.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  async apply(input: {
    run: DesignAnalysisRun;
    preview: GeneratedArtifactManifest;
    expectedPatchHash: string;
    overwritePaths: string[];
  }): Promise<{ patch: DesignPatchSet; applied: DesignApplyRecord }> {
    await this.recover(input.run.projectRoot);
    const patch = buildDesignPatchSet({ run: input.run, preview: input.preview, workspace: this.workspace, managedStore: this.managedStore });
    if (patch.hash !== input.expectedPatchHash) {
      throw new DesignToHarmonyError("PATCH_STALE", "Project files changed after the design patch was reviewed", { status: 409, retryable: true, stage: "apply" });
    }
    const overwrite = new Set(input.overwritePaths);
    const unresolved = patch.files.filter((file) => file.change === "conflict" && !overwrite.has(file.relativePath));
    const invalidOverwrite = patch.files.filter((file) => overwrite.has(file.relativePath) && (!file.overwriteAllowed || file.change !== "conflict"));
    if (unresolved.length || invalidOverwrite.length) {
      throw new DesignToHarmonyError("APPLY_BLOCKED", "The reviewed patch still contains unresolved conflicts", {
        status: 409,
        stage: "apply",
        details: { unresolved: unresolved.map((file) => file.relativePath), invalidOverwrite: invalidOverwrite.map((file) => file.relativePath) },
      });
    }
    const actionable = patch.files.filter((file) => file.change === "add" || file.change === "modify" || overwrite.has(file.relativePath));
    const adopted = patch.files.filter((file) => file.change === "unchanged" && file.managementMode === "unmanaged");
    if (actionable.length === 0 && adopted.length === 0) {
      throw new DesignToHarmonyError("APPLY_BLOCKED", "The project already matches this managed design preview", { status: 409, stage: "apply" });
    }

    const id = transactionId();
    const createdDirectories = new Set<string>();
    const operations: ApplyJournalOperation[] = [];
    const appliedAt = new Date().toISOString();
    const nextManagedFiles = this.nextManagedFiles(input.run, input.preview, patch, appliedAt);
    const journal: ApplyJournal = {
      schemaVersion: 1,
      id,
      projectRoot: resolve(input.run.projectRoot),
      state: "prepared",
      expectedManagedRevision: patch.managedStateRevision,
      createdDirectories: [],
      operations,
      nextManagedFiles,
    };

    try {
      for (const file of actionable) {
        if (!targetMatches(file)) throw new DesignToHarmonyError("PATCH_STALE", "A project file changed while the patch was being prepared", { status: 409, retryable: true, stage: "apply", details: { relativePath: file.relativePath } });
        const previewFile = this.workspace.readBytes(input.run.id, input.preview.id, file.relativePath);
        const expectedTarget = resolveDesignPatchTarget(input.run.projectRoot, file.relativePath);
        if (!pathsEqual(expectedTarget, file.targetPath)) throw new DesignToHarmonyError("PATCH_CONFLICT", "Reviewed patch target changed unexpectedly", { status: 409, stage: "apply" });
        const targetDirectory = dirname(file.targetPath);
        const missing: string[] = [];
        let cursor = targetDirectory;
        while (!existsSync(cursor) && !pathsEqual(cursor, input.run.projectRoot)) {
          missing.push(cursor);
          cursor = dirname(cursor);
        }
        mkdirSync(targetDirectory, { recursive: true, mode: 0o755 });
        assertRealDirectoryWithinProject(input.run.projectRoot, targetDirectory);
        const suffix = randomBytes(6).toString("hex");
        const temporaryPath = join(targetDirectory, `.piora-design-apply-${id}-${suffix}.tmp`);
        const backupPath = join(targetDirectory, `.piora-design-backup-${id}-${suffix}.tmp`);
        let mode = 0o644;
        if (file.currentExists) {
          const details = lstatSync(file.targetPath);
          if (details.isSymbolicLink() || !details.isFile()) throw new DesignToHarmonyError("PATCH_STALE", "A project target changed type while preparing the patch", { status: 409, retryable: true, stage: "apply", details: { relativePath: file.relativePath } });
          mode = details.mode & 0o777;
        }
        operations.push({ relativePath: file.relativePath, targetPath: file.targetPath, temporaryPath, backupPath, currentExists: file.currentExists, ...(file.currentSha256 ? { currentSha256: file.currentSha256 } : {}), previewSha256: file.previewSha256, mode, committed: false });
        for (const directory of missing) createdDirectories.add(directory);
        journal.createdDirectories = [...createdDirectories].sort();
        writeFileSync(temporaryPath, previewFile.data, { flag: "wx", mode, flush: true });
        chmodSync(temporaryPath, mode);
      }
      journal.createdDirectories = [...createdDirectories].sort();
      this.writeJournal(journal);
      journal.state = "committing";
      this.writeJournal(journal);
      for (const [index, operation] of operations.entries()) {
        const patchFile = patch.files.find((file) => file.relativePath === operation.relativePath);
        if (!patchFile || !targetMatches(patchFile)) throw new DesignToHarmonyError("PATCH_STALE", "A project file changed immediately before apply", { status: 409, retryable: true, stage: "apply", details: { relativePath: operation.relativePath } });
        if (operation.currentExists) renameSync(operation.targetPath, operation.backupPath);
        renameSync(operation.temporaryPath, operation.targetPath);
        operation.committed = true;
        this.writeJournal(journal);
        this.afterCommitForTests?.(operation.relativePath, index);
      }
      journal.state = "files_committed";
      this.writeJournal(journal);
      await this.managedStore.replace(input.run.projectRoot, patch.managedStateRevision, nextManagedFiles);
      this.cleanupCommitted(journal);
      const applied: DesignApplyRecord = {
        id,
        patchId: patch.id,
        appliedAt,
        appliedPaths: [...actionable.map((file) => file.relativePath), ...adopted.map((file) => file.relativePath)].sort(),
        overwrittenPaths: [...overwrite].sort(),
      };
      return { patch, applied };
    } catch (error) {
      try {
        this.rollback(journal);
      } catch (rollbackError) {
        if (rollbackError instanceof DesignToHarmonyError) throw rollbackError;
        throw new DesignToHarmonyError("APPLY_RECOVERY_REQUIRED", "Design apply failed and automatic rollback needs attention", { status: 500, retryable: true, stage: "apply", cause: rollbackError });
      }
      if (error instanceof DesignToHarmonyError) throw error;
      throw new DesignToHarmonyError("APPLY_FAILED", "Design patch could not be applied and was rolled back", { status: 500, retryable: true, stage: "apply", cause: error });
    }
  }
}

declare global {
  var __pioraDesignProjectApplyService: DesignProjectApplyService | undefined;
  var __pioraDesignProjectApplyLocks: Set<string> | undefined;
}

export function getDesignProjectApplyService(): DesignProjectApplyService {
  return globalThis.__pioraDesignProjectApplyService ??= new DesignProjectApplyService();
}

export async function runDesignApplyExclusive<T>(projectRoot: string, operation: () => Promise<T>): Promise<T> {
  const locks = globalThis.__pioraDesignProjectApplyLocks ??= new Set();
  const key = comparablePath(projectRoot);
  if (locks.has(key)) throw new DesignToHarmonyError("APPLY_BLOCKED", "Another design patch is already being applied to this project", { status: 423, retryable: true, stage: "apply" });
  locks.add(key);
  try {
    return await operation();
  } finally {
    locks.delete(key);
  }
}

export function resetDesignProjectApplyServiceForTests(): void {
  globalThis.__pioraDesignProjectApplyService = undefined;
  globalThis.__pioraDesignProjectApplyLocks = undefined;
}
