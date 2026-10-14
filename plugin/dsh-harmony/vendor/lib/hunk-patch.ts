import type { Hunk } from "./diff-parse.ts";

export function buildPatchForHunk(fullPatch: string, hunk: Hunk): string {
  const normalized = fullPatch.replace(/\r\n?/g, "\n");
  const headerEnd = normalized.indexOf("\n@@ ");
  const headers = headerEnd >= 0 ? normalized.slice(0, headerEnd) : normalized.split("\n").filter((line) => !line.startsWith("@@ ")).join("\n");
  const lines = hunk.lines.map((line) => {
    if (line.kind === "added") return `+${line.text}`;
    if (line.kind === "removed") return `-${line.text}`;
    if (line.kind === "meta") return line.text;
    return ` ${line.text}`;
  });
  return `${headers}\n${hunk.header}\n${lines.join("\n")}\n`;
}
