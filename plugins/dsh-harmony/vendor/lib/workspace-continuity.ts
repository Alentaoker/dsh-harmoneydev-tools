export const WORKSPACE_CONTINUITY_VERSION = 1;
export const MAX_PERSISTED_FILE_TABS = 24;
export const MAX_PERSISTED_EXPANDED_PATHS = 200;
const MAX_RAW_LENGTH = 128 * 1024;

export interface WorkspaceFileTab {
  id: string;
  label: string;
  filePath: string;
  cwd?: string;
  initialDisplayMode?: "source" | "preview" | "diff" | "edit";
}

export interface WorkspaceContinuity {
  version: 1;
  workspaceRoot: string;
  tabs: WorkspaceFileTab[];
  activeTabId: string | null;
  expandedPaths: string[];
}

export interface WorkspaceContinuityPatch {
  tabs?: readonly WorkspaceFileTab[];
  activeTabId?: string | null;
  expandedPaths?: Iterable<string>;
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function hasTraversal(value: string): boolean {
  return value.replace(/\\/g, "/").split("/").some((segment) => segment === ".." || segment === ".");
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

export function isWorkspacePath(workspaceRoot: string, candidate: string): boolean {
  if (hasTraversal(workspaceRoot) || hasTraversal(candidate)) return false;
  const root = normalizePath(workspaceRoot);
  const path = normalizePath(candidate);
  return path === root || path.startsWith(`${root}/`);
}

function sanitizeTab(value: unknown, workspaceRoot: string): WorkspaceFileTab | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const filePath = boundedString(record.filePath, 4096);
  const label = boundedString(record.label, 260);
  const cwd = record.cwd === undefined ? workspaceRoot : boundedString(record.cwd, 4096);
  if (!filePath || !label || !cwd || !isWorkspacePath(workspaceRoot, filePath) || !isWorkspacePath(workspaceRoot, cwd)) return null;
  const id = `file:${filePath}`;
  if (record.id !== undefined && record.id !== id) return null;
  const mode = record.initialDisplayMode;
  const initialDisplayMode = mode === "source" || mode === "preview" || mode === "diff" || mode === "edit" ? mode : undefined;
  return { id, label, filePath, cwd, ...(initialDisplayMode ? { initialDisplayMode } : {}) };
}

function emptyContinuity(workspaceRoot: string): WorkspaceContinuity {
  return { version: WORKSPACE_CONTINUITY_VERSION, workspaceRoot, tabs: [], activeTabId: null, expandedPaths: [] };
}

export function workspaceContinuityStorageKey(workspaceRoot: string): string {
  let hash = 2166136261;
  for (const char of normalizePath(workspaceRoot)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `piora-workspace-continuity-v1:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function parseWorkspaceContinuity(raw: string | null, workspaceRoot: string): WorkspaceContinuity {
  if (!raw || raw.length > MAX_RAW_LENGTH) return emptyContinuity(workspaceRoot);
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value.version !== WORKSPACE_CONTINUITY_VERSION
      || typeof value.workspaceRoot !== "string"
      || normalizePath(value.workspaceRoot) !== normalizePath(workspaceRoot)
    ) return emptyContinuity(workspaceRoot);
    const tabs = Array.isArray(value.tabs)
      ? value.tabs.slice(0, MAX_PERSISTED_FILE_TABS).flatMap((tab) => {
          const sanitized = sanitizeTab(tab, workspaceRoot);
          return sanitized ? [sanitized] : [];
        })
      : [];
    const seenTabIds = new Set<string>();
    const uniqueTabs = tabs.filter((tab) => {
      if (seenTabIds.has(tab.id)) return false;
      seenTabIds.add(tab.id);
      return true;
    });
    const activeTabId = typeof value.activeTabId === "string" && uniqueTabs.some((tab) => tab.id === value.activeTabId)
      ? value.activeTabId
      : uniqueTabs.at(-1)?.id ?? null;
    const seenPaths = new Set<string>();
    const expandedPaths = Array.isArray(value.expandedPaths)
      ? value.expandedPaths.slice(0, MAX_PERSISTED_EXPANDED_PATHS).flatMap((path) => {
          if (typeof path !== "string" || path.length > 4096 || !isWorkspacePath(workspaceRoot, path)) return [];
          const identity = normalizePath(path);
          if (seenPaths.has(identity)) return [];
          seenPaths.add(identity);
          return [path];
        })
      : [];
    return { version: WORKSPACE_CONTINUITY_VERSION, workspaceRoot, tabs: uniqueTabs, activeTabId, expandedPaths };
  } catch {
    return emptyContinuity(workspaceRoot);
  }
}

export function updateWorkspaceContinuity(
  raw: string | null,
  workspaceRoot: string,
  patch: WorkspaceContinuityPatch,
): string {
  const current = parseWorkspaceContinuity(raw, workspaceRoot);
  const candidate = {
    ...current,
    ...(patch.tabs ? { tabs: [...patch.tabs] } : {}),
    ...(patch.activeTabId !== undefined ? { activeTabId: patch.activeTabId } : {}),
    ...(patch.expandedPaths ? { expandedPaths: [...patch.expandedPaths] } : {}),
  };
  return JSON.stringify(parseWorkspaceContinuity(JSON.stringify(candidate), workspaceRoot));
}
