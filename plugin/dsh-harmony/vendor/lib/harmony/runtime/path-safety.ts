import { lstatSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { HarmonyError } from "../errors";

function redirectedPath(): HarmonyError {
  return new HarmonyError("INVALID_ARGUMENT", "Artifact paths cannot contain symbolic links or redirected parents");
}

/** Inspect actual entries: realpath string equality rejects valid Windows case/8.3 aliases. */
export async function assertUnredirectedPath(path: string): Promise<void> {
  for (let current = resolve(path);; current = dirname(current)) {
    if ((await lstat(current)).isSymbolicLink()) throw redirectedPath();
    if (dirname(current) === current) return;
  }
}

export function assertUnredirectedPathSync(path: string): void {
  for (let current = resolve(path);; current = dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) throw redirectedPath();
    if (dirname(current) === current) return;
  }
}
