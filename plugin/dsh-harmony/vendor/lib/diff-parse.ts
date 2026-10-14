export type DiffLineKind = "context" | "added" | "removed" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface Hunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath?: string;
  newPath?: string;
  status: "modified" | "added" | "deleted" | "renamed" | "binary";
  binary: boolean;
  headers: string[];
  hunks: Hunk[];
}

export interface ParsedDiff {
  files: DiffFile[];
  lineCount: number;
  binary: boolean;
}

export function parseUnifiedDiff(patch: string): ParsedDiff {
  const normalized = patch.replace(/\r\n?/g, "\n");
  if (!normalized.trim()) return { files: [], lineCount: 0, binary: false };
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let lineCount = 0;

  const ensureFile = () => {
    if (!file) {
      file = { status: "modified", binary: false, headers: [], hunks: [] };
      files.push(file);
    }
    return file;
  };

  const sourceLines = normalized.split("\n");
  if (sourceLines.at(-1) === "") sourceLines.pop();
  for (const line of sourceLines) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.*?) b\/(.*)$/);
      file = {
        oldPath: match?.[1], newPath: match?.[2], status: "modified",
        binary: false, headers: [line], hunks: [],
      };
      files.push(file);
      hunk = null;
      continue;
    }
    const current = ensureFile();
    if (line.startsWith("new file mode ")) { current.status = "added"; current.headers.push(line); continue; }
    if (line.startsWith("deleted file mode ")) { current.status = "deleted"; current.headers.push(line); continue; }
    if (line.startsWith("rename from ")) { current.status = "renamed"; current.oldPath = line.slice(12); current.headers.push(line); continue; }
    if (line.startsWith("rename to ")) { current.status = "renamed"; current.newPath = line.slice(10); current.headers.push(line); continue; }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      current.binary = true; current.status = "binary"; current.headers.push(line); hunk = null; continue;
    }
    if (line.startsWith("--- ")) {
      current.oldPath = cleanPath(line.slice(4));
      if (current.oldPath === "/dev/null") current.status = "added";
      current.headers.push(line);
      continue;
    }
    if (line.startsWith("+++ ")) {
      current.newPath = cleanPath(line.slice(4));
      if (current.newPath === "/dev/null") current.status = "deleted";
      current.headers.push(line);
      continue;
    }
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (match) {
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      hunk = {
        header: line,
        oldStart: oldLine,
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: newLine,
        newCount: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      };
      current.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      if (line) current.headers.push(line);
      continue;
    }
    if (line.startsWith("\\ No newline")) {
      hunk.lines.push({ kind: "meta", text: line, oldLine: null, newLine: null });
      lineCount++;
    } else if (line.startsWith("+")) {
      hunk.lines.push({ kind: "added", text: line.slice(1), oldLine: null, newLine: newLine++ });
      lineCount++;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "removed", text: line.slice(1), oldLine: oldLine++, newLine: null });
      lineCount++;
    } else {
      hunk.lines.push({ kind: "context", text: line.startsWith(" ") ? line.slice(1) : line, oldLine: oldLine++, newLine: newLine++ });
      lineCount++;
    }
  }

  return { files: files.filter((item) => item.hunks.length > 0 || item.headers.length > 0), lineCount, binary: files.some((item) => item.binary) };
}

function cleanPath(value: string): string {
  const path = value.split("\t")[0].trim();
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}
