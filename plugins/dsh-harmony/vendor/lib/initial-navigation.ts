export interface InitialNavigation {
  entryId: string | null;
  requestedCwd: string | null;
  sessionId: string | null;
}

export function getInitialNavigation(searchParams: Pick<URLSearchParams, "get">): InitialNavigation {
  const requestedCwd = searchParams.get("cwd")?.trim() || null;

  const sessionId = requestedCwd ? null : searchParams.get("session")?.trim() || null;
  return {
    entryId: sessionId ? searchParams.get("entry")?.trim() || null : null,
    requestedCwd,
    sessionId,
  };
}
