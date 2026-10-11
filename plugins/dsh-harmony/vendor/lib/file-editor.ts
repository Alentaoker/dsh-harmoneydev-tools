import { isUtf8 } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { TEXT_PREVIEW_MAX_BYTES } from "./file-types";
import { isPathWithinRoots } from "./path-security";

export const TEXT_EDIT_MAX_BYTES = TEXT_PREVIEW_MAX_BYTES;
// JSON escaping can expand a valid text payload (for example, control chars).
export const TEXT_EDIT_MAX_REQUEST_BYTES = TEXT_EDIT_MAX_BYTES * 6 + 16 * 1024;

export type TextFileSnapshot = {
  content: string;
  size: number;
  version: string;
  mtime: string;
};

export type TextFileMetadata = Omit<TextFileSnapshot, "content">;

export type SaveTextFileResult =
  | { status: "saved"; snapshot: TextFileSnapshot }
  | { status: "conflict"; current: TextFileMetadata };

export class TextFileEditError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    message: string,
    status: number,
    code: string,
  ) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function errorForFsFailure(error: unknown): TextFileEditError {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return new TextFileEditError("File not found", 404, "FILE_NOT_FOUND");
  if (code === "EACCES" || code === "EPERM") {
    return new TextFileEditError("File is not writable", 403, "FILE_NOT_WRITABLE");
  }
  return new TextFileEditError(
    error instanceof Error ? error.message : String(error),
    500,
    "FILE_SAVE_FAILED",
  );
}

function assertRegularFile(filePath: string): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw errorForFsFailure(error);
  }
  if (stat.isSymbolicLink()) {
    throw new TextFileEditError("Symbolic links cannot be edited", 400, "FILE_NOT_REGULAR");
  }
  if (!stat.isFile()) {
    throw new TextFileEditError("Edit target is not a regular file", 400, "FILE_NOT_REGULAR");
  }
  return stat;
}

function assertEditableText(bytes: Buffer): void {
  if (!isUtf8(bytes) || bytes.includes(0)) {
    throw new TextFileEditError("File is not valid UTF-8 text", 415, "FILE_NOT_UTF8_TEXT");
  }
}

function assertWithinSizeLimit(size: number): void {
  if (size > TEXT_EDIT_MAX_BYTES) {
    throw new TextFileEditError(
      "File is too large to edit (>256KB)",
      413,
      "FILE_TOO_LARGE",
    );
  }
}

export function getTextFileVersion(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Resolve an edit target without granting the read-only session-reference
 * exception used by the viewer. The leaf itself must not be a symbolic link,
 * and all resolved parent links must remain inside a resolved allowed root.
 */
export function resolveWritableTextFilePath(filePath: string, allowedRoots: Set<string>): string {
  if (!isPathWithinRoots(filePath, allowedRoots)) {
    throw new TextFileEditError("Access denied", 403, "FILE_ACCESS_DENIED");
  }

  assertRegularFile(filePath);

  let realFilePath: string;
  try {
    realFilePath = fs.realpathSync(filePath);
  } catch (error) {
    throw errorForFsFailure(error);
  }

  const realRoots = new Set<string>();
  for (const root of allowedRoots) {
    try {
      realRoots.add(fs.realpathSync(root));
    } catch {
      // Ignore stale roots from removed worktrees or sessions.
    }
  }
  if (!isPathWithinRoots(realFilePath, realRoots)) {
    throw new TextFileEditError("Access denied", 403, "FILE_ACCESS_DENIED");
  }

  return realFilePath;
}

export function readTextFileSnapshot(filePath: string): TextFileSnapshot {
  const before = fs.statSync(filePath);
  if (!before.isFile()) {
    throw new TextFileEditError("Not a file", 400, "FILE_NOT_REGULAR");
  }
  assertWithinSizeLimit(before.size);

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (error) {
    throw errorForFsFailure(error);
  }
  assertWithinSizeLimit(bytes.byteLength);
  assertEditableText(bytes);

  let after: fs.Stats;
  try {
    after = fs.statSync(filePath);
  } catch (error) {
    throw errorForFsFailure(error);
  }
  if (!after.isFile()) {
    throw new TextFileEditError("Not a file", 400, "FILE_NOT_REGULAR");
  }

  return {
    content: bytes.toString("utf8"),
    size: bytes.byteLength,
    version: getTextFileVersion(bytes),
    mtime: after.mtime.toISOString(),
  };
}

function writeTextFileAtomicSync(filePath: string, bytes: Buffer, mode: number): void {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}-${randomUUID()}.tmp`,
  );
  let operationFailed = false;

  try {
    fs.writeFileSync(temporaryPath, bytes, {
      flag: "wx",
      mode: mode & 0o777,
      flush: true,
    });
    // Respect the original file mode even when the process umask narrowed the
    // temporary file at creation time.
    fs.chmodSync(temporaryPath, mode & 0o777);
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !operationFailed) {
        throw error;
      }
    }
  }
}

export async function saveTextFileAtomic(
  filePath: string,
  content: string,
  expectedVersion: string,
  force = false,
): Promise<SaveTextFileResult> {
  const bytes = Buffer.from(content, "utf8");
  assertWithinSizeLimit(bytes.byteLength);
  assertEditableText(bytes);

  let lockCompromisedError: Error | undefined;
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(filePath, {
      realpath: false,
      retries: {
        retries: 6,
        factor: 1.5,
        minTimeout: 25,
        maxTimeout: 250,
        randomize: true,
      },
      stale: 30_000,
      onCompromised: (error) => {
        lockCompromisedError = error;
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ELOCKED") {
      throw new TextFileEditError("File is busy", 423, "FILE_BUSY");
    }
    throw errorForFsFailure(error);
  }

  const throwIfCompromised = () => {
    if (lockCompromisedError) {
      throw new TextFileEditError(lockCompromisedError.message, 409, "FILE_LOCK_LOST");
    }
  };

  try {
    throwIfCompromised();
    const stat = assertRegularFile(filePath);
    const current = readTextFileSnapshot(filePath);
    if (!force && current.version !== expectedVersion) {
      return {
        status: "conflict",
        current: {
          size: current.size,
          version: current.version,
          mtime: current.mtime,
        },
      };
    }

    throwIfCompromised();
    try {
      writeTextFileAtomicSync(filePath, bytes, stat.mode);
    } catch (error) {
      throw errorForFsFailure(error);
    }
    throwIfCompromised();
    return { status: "saved", snapshot: readTextFileSnapshot(filePath) };
  } finally {
    try {
      await release?.();
    } catch {
      // Prefer the operation/compromised-lock error over an unlock error.
    }
  }
}
