export type MarkdownEditorMode = "live" | "source";

export type MarkdownEditorCommand =
  | "bold" | "italic" | "strike" | "code" | "highlight" | "underline" | "subscript" | "superscript" | "link"
  | "paragraph" | "heading-1" | "heading-2" | "heading-3" | "heading-4" | "heading-5" | "heading-6"
  | "bullet-list" | "ordered-list" | "task-list" | "quote" | "code-block" | "math-block" | "horizontal-rule" | "table";

export interface TextSelection { from: number; to: number }
export interface MarkdownEdit { from: number; to: number; insert: string; selection: TextSelection }

const INLINE: Partial<Record<MarkdownEditorCommand, [string, string]>> = {
  bold: ["**", "**"], italic: ["*", "*"], strike: ["~~", "~~"], code: ["`", "`"],
  highlight: ["==", "=="], underline: ["<u>", "</u>"], subscript: ["~", "~"], superscript: ["^", "^"],
};

function lineRange(doc: string, from: number, to: number) {
  const start = doc.lastIndexOf("\n", Math.max(0, from - 1)) + 1;
  const lineEnd = doc.indexOf("\n", to);
  return { start, end: lineEnd < 0 ? doc.length : lineEnd };
}

function wrap(doc: string, selection: TextSelection, before: string, after: string, fallback = "文本"): MarkdownEdit {
  const selected = doc.slice(selection.from, selection.to);
  const hasWrapper = selection.from >= before.length && doc.slice(selection.from - before.length, selection.from) === before
    && doc.slice(selection.to, selection.to + after.length) === after;
  if (hasWrapper) {
    return { from: selection.from - before.length, to: selection.to + after.length, insert: selected,
      selection: { from: selection.from - before.length, to: selection.to - before.length } };
  }
  const content = selected || fallback;
  return { from: selection.from, to: selection.to, insert: `${before}${content}${after}`,
    selection: { from: selection.from + before.length, to: selection.from + before.length + content.length } };
}

function prefixLines(doc: string, selection: TextSelection, prefix: string | ((index: number) => string), pattern: RegExp): MarkdownEdit {
  const range = lineRange(doc, selection.from, selection.to);
  const source = doc.slice(range.start, range.end);
  const lines = source.split("\n");
  const everyPrefixed = lines.every((line) => pattern.test(line));
  const next = lines.map((line, index) => everyPrefixed ? line.replace(pattern, "") : `${typeof prefix === "function" ? prefix(index) : prefix}${line}`).join("\n");
  return { from: range.start, to: range.end, insert: next, selection: { from: range.start, to: range.start + next.length } };
}

export function applyMarkdownCommand(doc: string, selection: TextSelection, command: MarkdownEditorCommand, input?: string): MarkdownEdit {
  const inline = INLINE[command];
  if (inline) return wrap(doc, selection, inline[0], inline[1]);
  if (command === "link") return wrap(doc, selection, "[", `](${input?.trim() || "https://"})`, "链接文字");
  if (command.startsWith("heading-") || command === "paragraph") {
    const level = command === "paragraph" ? 0 : Number(command.at(-1));
    const range = lineRange(doc, selection.from, selection.to);
    const source = doc.slice(range.start, range.end);
    const next = source.split("\n").map((line) => `${level ? `${"#".repeat(level)} ` : ""}${line.replace(/^#{1,6}\s+/, "")}`).join("\n");
    return { from: range.start, to: range.end, insert: next, selection: { from: range.start, to: range.start + next.length } };
  }
  if (command === "bullet-list") return prefixLines(doc, selection, "- ", /^\s*[-+*]\s+/);
  if (command === "ordered-list") return prefixLines(doc, selection, (index) => `${index + 1}. `, /^\s*\d+[.)]\s+/);
  if (command === "task-list") return prefixLines(doc, selection, "- [ ] ", /^\s*[-+*]\s+\[[ xX]\]\s+/);
  if (command === "quote") return prefixLines(doc, selection, "> ", /^\s*>\s?/);
  if (command === "code-block") return wrap(doc, selection, "```\n", "\n```", "代码");
  if (command === "math-block") return wrap(doc, selection, "$$\n", "\n$$", "E = mc^2");
  if (command === "horizontal-rule") {
    const range = lineRange(doc, selection.from, selection.to);
    const insert = `${range.start ? "\n" : ""}---\n`;
    return { from: range.start, to: range.start, insert, selection: { from: range.start + insert.length, to: range.start + insert.length } };
  }
  const table = input || "| 标题 1 | 标题 2 |\n| --- | --- |\n| 内容 | 内容 |";
  return { from: selection.from, to: selection.to, insert: table, selection: { from: selection.from, to: selection.from + table.length } };
}

function splitTableRow(line: string): string[] {
  const text = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "|" && text[index - 1] !== "\\") { cells.push(cell.trim()); cell = ""; }
    else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

const separatorRow = (line: string) => splitTableRow(line).every((cell) => /^:?-{3,}:?$/.test(cell));
const renderTableRow = (cells: string[]) => `| ${cells.join(" | ")} |`;

export interface MarkdownTableContext {
  from: number; to: number; row: number; column: number; rows: string[][];
}

export function markdownTableAt(doc: string, position: number): MarkdownTableContext | null {
  const lines = doc.split("\n");
  let offset = 0;
  const ranges = lines.map((line) => { const from = offset; offset += line.length + 1; return { line, from, to: from + line.length }; });
  const current = ranges.findIndex(({ from, to }) => position >= from && position <= to + 1);
  if (current < 0 || !ranges[current].line.includes("|")) return null;
  let start = current, end = current;
  while (start > 0 && ranges[start - 1].line.includes("|")) start--;
  while (end + 1 < ranges.length && ranges[end + 1].line.includes("|")) end++;
  if (end - start < 1 || !separatorRow(ranges[start + 1].line)) return null;
  const rawRows = ranges.slice(start, end + 1).map(({ line }) => splitTableRow(line));
  const columns = Math.max(...rawRows.map((row) => row.length));
  if (!columns) return null;
  const column = Math.min(columns - 1, ranges[current].line.slice(0, Math.max(0, position - ranges[current].from)).split(/(?<!\\)\|/).length - 1);
  return { from: ranges[start].from, to: ranges[end].to, row: current - start, column: Math.max(0, column), rows: rawRows.map((row) => [...row, ...Array(columns - row.length).fill("")]) };
}

export type TableCommand = "row-before" | "row-after" | "row-delete" | "column-before" | "column-after" | "column-delete" | "align-left" | "align-center" | "align-right";

export function applyTableCommand(context: MarkdownTableContext, command: TableCommand): MarkdownEdit {
  const rows = context.rows.map((row) => [...row]);
  if (command === "row-before" || command === "row-after") {
    const index = Math.max(2, context.row + (command === "row-after" ? 1 : 0));
    rows.splice(index, 0, Array(rows[0].length).fill(""));
  } else if (command === "row-delete" && context.row > 1 && rows.length > 2) {
    rows.splice(context.row, 1);
  } else if (command.startsWith("column-")) {
    if (command === "column-delete" && rows[0].length > 1) rows.forEach((row) => row.splice(context.column, 1));
    else if (command !== "column-delete") { const index = context.column + (command === "column-after" ? 1 : 0); rows.forEach((row, rowIndex) => row.splice(index, 0, rowIndex === 1 ? "---" : "")); }
  } else {
    const marker = rows[1][context.column].replace(/:/g, "").replace(/[^-]/g, "") || "---";
    rows[1][context.column] = command === "align-center" ? `:${marker}:` : command === "align-right" ? `${marker}:` : `:${marker}`;
  }
  const insert = rows.map(renderTableRow).join("\n");
  return { from: context.from, to: context.to, insert, selection: { from: context.from, to: context.from + insert.length } };
}

export function updateTableCell(context: MarkdownTableContext, row: number, column: number, value: string): MarkdownEdit {
  const rows = context.rows.map((cells) => [...cells]);
  if (!rows[row] || column < 0 || column >= rows[row].length || row === 1) {
    return { from: context.from, to: context.to, insert: rows.map(renderTableRow).join("\n"), selection: { from: context.from, to: context.from } };
  }
  rows[row][column] = value.replace(/\r?\n/g, " ").replace(/(?<!\\)\|/g, "\\|").trim();
  const insert = rows.map(renderTableRow).join("\n");
  return { from: context.from, to: context.to, insert, selection: { from: context.from, to: context.from } };
}

export interface MarkdownImageContext { from: number; to: number; alt: string; src: string; title: string; width: number | null }

export function markdownImageAt(doc: string, position: number): MarkdownImageContext | null {
  const patterns = [
    /!\[([^\]]*)\]\((\S+?)(?:\s+["']([^"']*)["'])?\)/g,
    /<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi,
  ];
  for (const pattern of patterns) {
    for (const match of doc.matchAll(pattern)) {
      const from = match.index!, to = from + match[0].length;
      if (position < from || position > to) continue;
      if (pattern === patterns[0]) return { from, to, alt: match[1], src: match[2], title: match[3] || "", width: null };
      const alt = /\balt=["']([^"']*)["']/i.exec(match[0])?.[1] || "";
      const title = /\btitle=["']([^"']*)["']/i.exec(match[0])?.[1] || "";
      const width = Number(/\bwidth=["']?(\d+)/i.exec(match[0])?.[1]) || null;
      return { from, to, alt, src: match[1], title, width };
    }
  }
  return null;
}

export function updateMarkdownImage(context: MarkdownImageContext, value: { alt: string; src: string; title?: string; width?: number | null }): MarkdownEdit {
  const escapedAlt = value.alt.replace(/[\[\]\r\n]/g, "_");
  const title = value.title?.trim().replace(/["\r\n]/g, "'") || "";
  const width = value.width && Number.isFinite(value.width) ? Math.max(40, Math.min(2400, Math.round(value.width))) : null;
  const insert = width
    ? `<img src="${value.src}" alt="${escapedAlt}"${title ? ` title="${title}"` : ""} width="${width}">`
    : `![${escapedAlt}](${value.src}${title ? ` "${title}"` : ""})`;
  return { from: context.from, to: context.to, insert, selection: { from: context.from, to: context.from + insert.length } };
}
