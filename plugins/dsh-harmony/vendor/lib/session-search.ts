import type { SessionInfo } from "./types";

export function normalizeSessionSearch(query: string): string {
  return query.trim().toLocaleLowerCase();
}

export function sessionMatchesSearch(session: SessionInfo, projectLabel: string, query: string): boolean {
  const needle = normalizeSessionSearch(query);
  if (!needle) return true;
  const title = session.name || session.firstMessage || session.id;
  return `${title}\n${session.cwd}\n${projectLabel}`.toLocaleLowerCase().includes(needle);
}

export function filterSessions(sessions: SessionInfo[], projectLabel: string, query: string): SessionInfo[] {
  const needle = normalizeSessionSearch(query);
  if (!needle) return sessions;
  return sessions.filter((session) => sessionMatchesSearch(session, projectLabel, needle));
}
