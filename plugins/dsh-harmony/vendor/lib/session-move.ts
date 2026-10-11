import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { allowFileRoot } from "./file-access";
import { getRpcSession } from "./rpc-manager";
import {
  cacheSessionPath,
  invalidateSessionListCache,
  invalidateSessionPathCache,
  listAllSessions,
  getAgentDir,
} from "./session-reader";
import { sessionPathKey } from "./session-path";

export class SessionMoveError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "SessionMoveError";
  }
}

interface StagedSessionMove {
  id: string;
  sourcePath: string;
  destinationPath: string;
  temporaryPath: string;
  backupPath: string;
  contents: string;
}

function rewriteSessionHeader(
  contents: string,
  targetCwd: string,
  movedPathBySource: ReadonlyMap<string, string>,
): string {
  const newlineIndex = contents.indexOf("\n");
  const headerLine = (newlineIndex >= 0 ? contents.slice(0, newlineIndex) : contents).replace(/\r$/, "");
  const header = JSON.parse(headerLine) as { type?: string; cwd?: string; parentSession?: string };
  if (header.type !== "session") throw new SessionMoveError("Session header is invalid", 409);
  header.cwd = targetCwd;
  if (header.parentSession) {
    header.parentSession = movedPathBySource.get(sessionPathKey(header.parentSession)) ?? header.parentSession;
  }
  return `${JSON.stringify(header)}${newlineIndex >= 0 ? contents.slice(newlineIndex) : ""}`;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function getSessionDirectory(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolve(getAgentDir()), "sessions", safePath);
}

/** Move a conversation and every fork below it without breaking parent paths. */
export async function moveSessionTreeToCwd(sessionId: string, requestedCwd: string) {
  const targetCwd = normalize(requestedCwd.trim());
  if (!targetCwd || !isAbsolute(targetCwd)) {
    throw new SessionMoveError("Target project must be an absolute directory", 400);
  }
  let targetStats;
  try {
    targetStats = await stat(targetCwd);
  } catch {
    throw new SessionMoveError("Target project directory does not exist", 400);
  }
  if (!targetStats.isDirectory()) throw new SessionMoveError("Target project is not a directory", 400);

  const sessions = await listAllSessions();
  const source = sessions.find((session) => session.id === sessionId);
  if (!source) throw new SessionMoveError("Session not found", 404);
  if (sessionPathKey(source.cwd) === sessionPathKey(targetCwd)) {
    throw new SessionMoveError("Session is already in this project", 409);
  }

  const descendants = new Set<string>([sessionId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const session of sessions) {
      if (session.parentSessionId && descendants.has(session.parentSessionId) && !descendants.has(session.id)) {
        descendants.add(session.id);
        changed = true;
      }
    }
  }
  const movingSessions = sessions.filter((session) => descendants.has(session.id));
  for (const session of movingSessions) {
    if (getRpcSession(session.id)?.isRunning()) {
      throw new SessionMoveError("A session in this conversation tree is still running", 409);
    }
  }

  allowFileRoot(targetCwd);
  const targetDirectory = getSessionDirectory(targetCwd);
  await mkdir(targetDirectory, { recursive: true });
  const operationId = randomUUID();
  const movedPathBySource = new Map<string, string>();
  for (const session of movingSessions) {
    movedPathBySource.set(sessionPathKey(session.path), join(targetDirectory, basename(session.path)));
  }

  const staged: StagedSessionMove[] = [];
  for (const [index, session] of movingSessions.entries()) {
    const destinationPath = movedPathBySource.get(sessionPathKey(session.path))!;
    if (await pathExists(destinationPath)) {
      throw new SessionMoveError(`A session file with the same name already exists in the target project: ${basename(destinationPath)}`, 409);
    }
    const sourceContents = await readFile(session.path, "utf8");
    staged.push({
      id: session.id,
      sourcePath: session.path,
      destinationPath,
      temporaryPath: join(targetDirectory, `.piora-move-${operationId}-${index}.tmp`),
      backupPath: join(dirname(session.path), `.${basename(session.path)}.piora-move-${operationId}.bak`),
      contents: rewriteSessionHeader(sourceContents, targetCwd, movedPathBySource),
    });
  }

  const backedUp: StagedSessionMove[] = [];
  const promoted: StagedSessionMove[] = [];
  try {
    await Promise.all(staged.map((entry) => writeFile(entry.temporaryPath, entry.contents, { flag: "wx" })));
    for (const entry of staged) {
      getRpcSession(entry.id)?.destroy();
      await rename(entry.sourcePath, entry.backupPath);
      backedUp.push(entry);
    }
    for (const entry of staged) {
      await rename(entry.temporaryPath, entry.destinationPath);
      promoted.push(entry);
    }
  } catch (error) {
    await Promise.allSettled(promoted.map((entry) => rm(entry.destinationPath, { force: true })));
    for (const entry of backedUp.reverse()) {
      if (await pathExists(entry.backupPath)) await rename(entry.backupPath, entry.sourcePath).catch(() => undefined);
    }
    await Promise.allSettled(staged.map((entry) => rm(entry.temporaryPath, { force: true })));
    throw error;
  }

  await Promise.allSettled(staged.map((entry) => rm(entry.backupPath, { force: true })));
  for (const entry of staged) {
    invalidateSessionPathCache(entry.id);
    cacheSessionPath(entry.id, entry.destinationPath);
  }
  invalidateSessionListCache();
  return {
    sessionId,
    cwd: targetCwd,
    movedSessionIds: staged.map((entry) => entry.id),
  };
}
