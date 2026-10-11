import type { GitStatusResponse } from "./git-types";

/**
 * The conversation header reports only lines in Git's tracked diff. Untracked
 * files remain discoverable in the change list, but their complete contents
 * must not inflate the header's additions/deletions counters.
 */
export function getTrackedGitLineStats(status: GitStatusResponse): {
  additions: number;
  deletions: number;
} {
  let untrackedAdditions = 0;
  let untrackedDeletions = 0;
  for (const file of status.files) {
    if (file.status !== "untracked") continue;
    untrackedAdditions += file.additions ?? 0;
    untrackedDeletions += file.deletions ?? 0;
  }
  return {
    additions: Math.max(0, status.additions - untrackedAdditions),
    deletions: Math.max(0, status.deletions - untrackedDeletions),
  };
}
