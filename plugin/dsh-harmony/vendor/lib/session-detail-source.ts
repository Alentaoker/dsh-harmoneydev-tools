export interface LiveSessionDetailSource<Manager> {
  isAlive(): boolean;
  sessionFile: string;
  inner: { sessionManager: Manager };
}

export type SessionDetailSource<Manager> =
  | { kind: "memory"; filePath: string; manager: Manager }
  | { kind: "file"; filePath: string };

export async function resolveSessionDetailSource<Manager>(
  sessionId: string,
  dependencies: {
    getLiveSession(id: string): LiveSessionDetailSource<Manager> | undefined;
    resolveSessionPath(id: string): Promise<string | null>;
    sessionFileExists(filePath: string): boolean;
  },
): Promise<SessionDetailSource<Manager> | null> {
  const live = dependencies.getLiveSession(sessionId);
  if (live?.isAlive() && (!live.sessionFile || !dependencies.sessionFileExists(live.sessionFile))) {
    return {
      kind: "memory",
      filePath: live.sessionFile,
      manager: live.inner.sessionManager,
    };
  }

  const filePath = await dependencies.resolveSessionPath(sessionId);
  return filePath ? { kind: "file", filePath } : null;
}

export function isMissingSessionFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}
