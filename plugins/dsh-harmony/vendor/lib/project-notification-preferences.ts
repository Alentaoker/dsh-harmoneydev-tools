export const PROJECT_NOTIFICATION_STORAGE_KEY = "piora-muted-project-notifications:v1";
export const PROJECT_NOTIFICATION_CHANGE_EVENT = "piora:project-notification-preferences-changed";

const MAX_PROJECTS = 500;
const MAX_PROJECT_ROOT_LENGTH = 2_048;

export function normalizeNotificationProjectRoot(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized || normalized.length > MAX_PROJECT_ROOT_LENGTH) return null;
  if (/^[a-z]:\//i.test(normalized) || normalized.startsWith("//")) normalized = normalized.toLocaleLowerCase();
  return normalized;
}

export function parseMutedProjectRoots(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const value = JSON.parse(raw) as { version?: unknown; muted?: unknown };
    if (value.version !== 1 || !Array.isArray(value.muted)) return new Set();
    return new Set(value.muted.slice(0, MAX_PROJECTS).flatMap((root) => {
      const normalized = normalizeNotificationProjectRoot(root);
      return normalized ? [normalized] : [];
    }));
  } catch {
    return new Set();
  }
}

export function serializeMutedProjectRoots(roots: ReadonlySet<string>): string {
  return JSON.stringify({ version: 1, muted: [...roots].slice(0, MAX_PROJECTS) });
}

export function isProjectNotificationMuted(roots: ReadonlySet<string>, projectRoot: unknown): boolean {
  const normalized = normalizeNotificationProjectRoot(projectRoot);
  return normalized ? roots.has(normalized) : false;
}

export function filterMutedSessionIds(
  ids: Iterable<string>,
  sessions: readonly { id: string; cwd: string; projectRoot?: string }[],
  mutedProjectRoots: ReadonlySet<string>,
): string[] {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  return [...ids].filter((id) => {
    const session = sessionsById.get(id);
    return !session || !isProjectNotificationMuted(mutedProjectRoots, session.projectRoot ?? session.cwd);
  });
}
