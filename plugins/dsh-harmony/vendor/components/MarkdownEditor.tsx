"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Compartment, EditorSelection, EditorState, StateField, Transaction } from "@codemirror/state";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { insertNewlineContinueMarkup, markdown, markdownKeymap } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { openSearchPanel, searchKeymap } from "@codemirror/search";
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from "@codemirror/commands";
import { Decoration, EditorView, WidgetType, drawSelection, dropCursor, highlightActiveLine, highlightSpecialChars, keymap, lineNumbers, placeholder, rectangularSelection, type DecorationSet, type KeyBinding } from "@codemirror/view";
import katex from "katex";
import { applyMarkdownCommand, applyTableCommand, markdownImageAt, markdownTableAt, updateMarkdownImage, updateTableCell, type MarkdownEditorCommand, type MarkdownEditorMode, type MarkdownImageContext, type MarkdownTableContext, type TableCommand } from "@/lib/markdown-editor-commands";
import { clipboardHtmlToMarkdown } from "@/lib/html-to-markdown";
import "./MarkdownEditor.css";

export interface MarkdownEditorHandle {
  insert(before: string, after?: string): void;
  focus(): void;
  search(): void;
  jumpTo(offset: number): void;
  flush(): Promise<boolean>;
  isBusy(): boolean;
  setMode(mode: MarkdownEditorMode): void;
  getMode(): MarkdownEditorMode;
  command(command: MarkdownEditorCommand): void;
}
interface Props { value: string; onChange(value: string): void; onSave(): void; onImage(file: File): Promise<string>; editorRef?: Ref<MarkdownEditorHandle>; onModeChange?(mode: MarkdownEditorMode): void; onCursorChange?(offset: number): void; focusLine?: boolean; typewriter?: boolean }
type ContextMenuState = { x: number; y: number; position: number; table: boolean; image: boolean } | null;
type DecorationRange = ReturnType<ReturnType<typeof Decoration.replace>["range"]>;

class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string, readonly position: number, readonly width: number | null) { super(); }
  eq(other: ImageWidget) { return other.src === this.src && other.alt === this.alt && other.position === this.position && other.width === this.width; }
  toDOM(view: EditorView) {
    const figure = document.createElement("figure"); figure.className = "cm-md-image"; figure.tabIndex = 0; figure.setAttribute("aria-label", this.alt || "Markdown 图片");
    const image = document.createElement("img"); image.src = this.src; image.alt = this.alt; if (this.width) image.style.width = `${this.width}px`;
    const caption = document.createElement("figcaption"); caption.textContent = this.alt || "点击编辑图片"; figure.append(image, caption);
    const edit = () => view.dom.dispatchEvent(new CustomEvent("piora-markdown-image", { bubbles: true, detail: { position: this.position } }));
    figure.addEventListener("click", edit);
    figure.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); edit(); } });
    figure.addEventListener("contextmenu", (event) => { event.preventDefault(); view.dom.dispatchEvent(new CustomEvent("piora-markdown-context", { bubbles: true, detail: { x: event.clientX, y: event.clientY, position: this.position } })); });
    return figure;
  }
  ignoreEvent() { return true; }
}
class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly from: number) { super(); }
  eq(other: CheckboxWidget) { return other.checked === this.checked && other.from === this.from; }
  toDOM(view: EditorView) {
    const input = document.createElement("input"); input.type = "checkbox"; input.checked = this.checked; input.className = "cm-md-task"; input.setAttribute("aria-label", this.checked ? "标记任务为未完成" : "标记任务为已完成");
    input.addEventListener("change", () => view.dispatch({ changes: { from: this.from + 1, to: this.from + 2, insert: input.checked ? "x" : " " }, userEvent: "input" })); return input;
  }
  ignoreEvent() { return true; }
}
class RuleWidget extends WidgetType { toDOM() { const rule = document.createElement("hr"); rule.className = "cm-md-rule"; return rule; } }
class TableWidget extends WidgetType {
  constructor(readonly table: MarkdownTableContext) { super(); }
  eq(other: TableWidget) { return other.table.from === this.table.from && JSON.stringify(other.table.rows) === JSON.stringify(this.table.rows); }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div"); wrap.className = "cm-md-table-wrap"; wrap.dataset.tableFrom = String(this.table.from);
    const table = document.createElement("table"); table.className = "cm-md-table";
    const shownRows = [this.table.rows[0], ...this.table.rows.slice(2)];
    shownRows.forEach((cells, rowIndex) => {
      const row = document.createElement("tr");
      cells.forEach((text, columnIndex) => {
        const sourceRow = rowIndex === 0 ? 0 : rowIndex + 1;
        const cell = document.createElement(rowIndex ? "td" : "th"); cell.textContent = text || " "; cell.tabIndex = 0; cell.contentEditable = "true"; cell.dataset.row = String(sourceRow); cell.dataset.column = String(columnIndex);
        const alignment = this.table.rows[1][columnIndex].startsWith(":") && this.table.rows[1][columnIndex].endsWith(":") ? "center" : this.table.rows[1][columnIndex].endsWith(":") ? "right" : "left"; cell.style.textAlign = alignment;
        const position = Math.min(this.table.to, this.table.from + this.table.rows.slice(0, sourceRow).reduce((sum, item) => sum + item.join(" | ").length + 5, 0) + cells.slice(0, columnIndex).join(" | ").length + 2);
        let committed = false;
        const commit = (next?: { row: number; column: number }) => { committed = true; view.dom.dispatchEvent(new CustomEvent("piora-markdown-table-cell", { bubbles: true, detail: { position, row: sourceRow, column: columnIndex, value: cell.textContent || "", next } })); };
        cell.addEventListener("blur", () => { if (!committed && (cell.textContent || "").trim() !== text) commit(); });
        cell.addEventListener("keydown", (event) => {
          if (event.key === "Enter") { event.preventDefault(); commit(); }
          if (event.key === "Tab") { event.preventDefault(); const shownRow = rowIndex + (event.shiftKey ? (columnIndex === 0 ? -1 : 0) : (columnIndex === cells.length - 1 ? 1 : 0)); const nextColumn = event.shiftKey ? (columnIndex === 0 ? cells.length - 1 : columnIndex - 1) : (columnIndex === cells.length - 1 ? 0 : columnIndex + 1); const nextSourceRow = shownRow === 0 ? 0 : shownRow + 1; commit({ row: Math.max(0, nextSourceRow), column: nextColumn }); }
          if (event.key === "Escape") { event.preventDefault(); cell.textContent = text || " "; cell.blur(); }
        });
        cell.addEventListener("contextmenu", (event) => { event.preventDefault(); view.dom.dispatchEvent(new CustomEvent("piora-markdown-context", { bubbles: true, detail: { x: event.clientX, y: event.clientY, position } })); });
        row.appendChild(cell);
      }); table.appendChild(row);
    });
    const hint = document.createElement("span"); hint.textContent = "点击单元格编辑 · 右键管理行列"; hint.className = "cm-md-table-hint";
    wrap.append(table, hint); return wrap;
  }
  ignoreEvent() { return true; }
}
class MathWidget extends WidgetType {
  constructor(readonly source: string) { super(); }
  eq(other: MathWidget) { return other.source === this.source; }
  toDOM() { const output = document.createElement("div"); output.className = "cm-md-math"; try { katex.render(this.source, output, { displayMode: true, throwOnError: false, strict: false }); } catch { output.textContent = this.source; output.classList.add("cm-md-render-error"); } return output; }
}
class InlineMathWidget extends WidgetType {
  constructor(readonly source: string) { super(); }
  eq(other: InlineMathWidget) { return other.source === this.source; }
  toDOM() { const output = document.createElement("span"); output.className = "cm-md-inline-math"; try { katex.render(this.source, output, { throwOnError: false, strict: false }); } catch { output.textContent = this.source; output.classList.add("cm-md-render-error"); } return output; }
}
class MermaidWidget extends WidgetType {
  constructor(readonly source: string) { super(); }
  eq(other: MermaidWidget) { return other.source === this.source; }
  toDOM() {
    const output = document.createElement("div"); output.className = "cm-md-mermaid"; output.textContent = "正在渲染图表…";
    void import("mermaid").then(async ({ default: mermaid }) => { mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: document.documentElement.dataset.theme === "dark" ? "dark" : "default" }); const { svg } = await mermaid.render(`piora-md-${crypto.randomUUID()}`, this.source); if (output.isConnected) output.innerHTML = svg; }).catch((cause) => { if (output.isConnected) { output.textContent = cause instanceof Error ? cause.message : "图表语法有误"; output.classList.add("cm-md-render-error"); } });
    return output;
  }
}

function inlineDecorations(line: { from: number; text: string }, ranges: DecorationRange[]) {
  const patterns = [
    { regex: /\*\*([^*\n]+)\*\*/g, className: "cm-md-strong", marker: 2 }, { regex: /~~([^~\n]+)~~/g, className: "cm-md-strike", marker: 2 },
    { regex: /==([^=\n]+)==/g, className: "cm-md-highlight", marker: 2 }, { regex: /(?<!\*)\*([^*\n]+)\*(?!\*)/g, className: "cm-md-em", marker: 1 },
    { regex: /`([^`\n]+)`/g, className: "cm-md-code", marker: 1 }, { regex: /<u>([^\n]+?)<\/u>/gi, className: "cm-md-underline", marker: 3, tail: 4 },
    { regex: /(?<!~)~([^~\n]+)~(?!~)/g, className: "cm-md-subscript", marker: 1 }, { regex: /\^([^\^\n]+)\^/g, className: "cm-md-superscript", marker: 1 },
  ];
  for (const { regex, className, marker, tail = marker } of patterns) for (const match of line.text.matchAll(regex)) {
    const from = line.from + match.index!, to = from + match[0].length;
    ranges.push(Decoration.replace({}).range(from, from + marker), Decoration.mark({ class: className }).range(from + marker, to - tail), Decoration.replace({}).range(to - tail, to));
  }
  for (const match of line.text.matchAll(/\[([^\]\n]+)\]\(([^)\n]+)\)/g)) { const from = line.from + match.index!, labelFrom = from + 1, labelTo = labelFrom + match[1].length, to = from + match[0].length; ranges.push(Decoration.replace({}).range(from, labelFrom), Decoration.mark({ class: "cm-md-link" }).range(labelFrom, labelTo), Decoration.replace({}).range(labelTo, to)); }
  for (const match of line.text.matchAll(/(?<!\$)\$([^$\n]+)\$(?!\$)/g)) { const from = line.from + match.index!, to = from + match[0].length; ranges.push(Decoration.replace({ widget: new InlineMathWidget(match[1]) }).range(from, to)); }
}
function buildLiveDecorations(state: EditorState): DecorationSet {
  const ranges: DecorationRange[] = [], doc = state.doc, sourceDoc = doc.toString(); let inFence = false;
  for (let position = 0; position <= doc.length;) {
    const line = doc.lineAt(position), text = line.text, active = state.selection.main.head >= line.from && state.selection.main.head <= line.to;
    const fence = /^\s*(```|~~~)/.test(text), wasInFence = inFence;
    const table = !wasInFence && !fence ? markdownTableAt(sourceDoc, line.from) : null;
    if (table?.from === line.from && !(state.selection.main.head >= table.from && state.selection.main.head <= table.to)) {
      ranges.push(Decoration.replace({ widget: new TableWidget(table), block: true }).range(table.from, table.to));
      if (table.to >= doc.length) break;
      position = doc.lineAt(table.to).to + 1; continue;
    }
    if (!wasInFence && /^\s*```\s*mermaid\s*$/i.test(text)) { let number = line.number + 1; const source: string[] = []; while (number <= doc.lines) { const candidate = doc.line(number); if (/^\s*```\s*$/.test(candidate.text)) { if (!(state.selection.main.head >= line.from && state.selection.main.head <= candidate.to)) ranges.push(Decoration.replace({ widget: new MermaidWidget(source.join("\n")), block: true }).range(line.from, candidate.to)); else { ranges.push(Decoration.line({ class: "cm-md-code-line" }).range(line.from)); for (let inner = line.number + 1; inner <= candidate.number; inner++) ranges.push(Decoration.line({ class: "cm-md-code-line" }).range(doc.line(inner).from)); } if (candidate.to >= doc.length) return Decoration.set(ranges, true); position = candidate.to + 1; break; } source.push(candidate.text); number++; } if (number <= doc.lines) continue; }
    const heading = /^\s*(#{1,6})\s+/.exec(text);
    if (!wasInFence && !fence && heading) { ranges.push(Decoration.line({ class: `cm-md-heading cm-md-heading-${heading[1].length}` }).range(line.from)); if (!active) ranges.push(Decoration.replace({}).range(line.from, line.from + heading[0].length)); }
    else if (!wasInFence && !fence && /^\s*>\s?/.test(text)) ranges.push(Decoration.line({ class: "cm-md-quote" }).range(line.from));
    else if (!wasInFence && !fence && /^\s*(?:[-+*]|\d+[.)])\s+/.test(text)) ranges.push(Decoration.line({ class: "cm-md-list" }).range(line.from));
    else if (wasInFence || fence) ranges.push(Decoration.line({ class: "cm-md-code-line" }).range(line.from));
    const imageMarker = text.includes("![") ? text.indexOf("![") : text.search(/<img\s/i);
    const image = imageMarker >= 0 ? markdownImageAt(sourceDoc, line.from + imageMarker) : null;
    const imageOnly = image && sourceDoc.slice(image.from, image.to).trim() === text.trim();
    if (!wasInFence && !fence && !active && image && imageOnly) ranges.push(Decoration.replace({ widget: new ImageWidget(image.src, image.alt, image.from, image.width), block: true }).range(line.from, line.to));
    else if (!wasInFence && !fence && !active && /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(text)) ranges.push(Decoration.replace({ widget: new RuleWidget(), block: true }).range(line.from, line.to));
    else if (!wasInFence && !fence && !active) inlineDecorations(line, ranges);
    if (!wasInFence && !fence) for (const task of text.matchAll(/\[[ xX]\]/g)) { const from = line.from + task.index!; ranges.push(Decoration.replace({ widget: new CheckboxWidget(task[0].toLowerCase() === "[x]", from) }).range(from, from + 3)); }
    if (!wasInFence && !active && text.trim() === "$$") { let number = line.number + 1; const source: string[] = []; while (number <= doc.lines) { const candidate = doc.line(number); if (candidate.text.trim() === "$$") { if (source.length) ranges.push(Decoration.replace({ widget: new MathWidget(source.join("\n")), block: true }).range(line.from, candidate.to)); if (candidate.to >= doc.length) return Decoration.set(ranges, true); position = candidate.to + 1; break; } source.push(candidate.text); number++; } if (number <= doc.lines) continue; }
    if (fence) inFence = !inFence;
    if (line.number === doc.lines) break; position = line.to + 1;
  }
  return Decoration.set(ranges, true);
}
const livePreview = StateField.define<DecorationSet>({
  create: buildLiveDecorations,
  update(value, transaction) { return transaction.docChanged || transaction.selection ? buildLiveDecorations(transaction.state) : value; },
  provide: (field) => EditorView.decorations.from(field),
});
const editorTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--text)" }, ".cm-scroller": { overflow: "auto", fontFamily: "var(--ui-font-family, system-ui), sans-serif", lineHeight: "1.85" },
  ".cm-content": { width: "100%", maxWidth: "var(--writing-width, 100%)", margin: "0 auto", padding: "22px 28px 72px", caretColor: "var(--text)" }, ".cm-line": { padding: "0" }, ".cm-focused": { outline: "none" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "color-mix(in srgb, var(--accent) 24%, transparent)" }, ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-gutters": { backgroundColor: "var(--bg-panel)", color: "var(--text-dim)", borderRight: "1px solid var(--border)" }, ".cm-cursor": { borderLeftColor: "var(--text)" },
  ".cm-panels": { backgroundColor: "var(--bg-panel)", color: "var(--text)", borderColor: "var(--border)" }, ".cm-search": { padding: "7px 12px !important" },
  ".cm-search input": { backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "5px", padding: "5px 7px" },
  ".cm-search button": { backgroundImage: "none", backgroundColor: "transparent", color: "var(--text-muted)", border: "0", borderRadius: "5px", padding: "5px 7px" },
});
function menuPosition(x: number, y: number) { const width = 238, margin = 8; return { left: Math.max(margin, Math.min(x, window.innerWidth - width - margin)), top: Math.max(margin, y), width, visibility: "hidden" as const }; }

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, Props>(function MarkdownEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null), menuRef = useRef<HTMLDivElement>(null), viewRef = useRef<EditorView | null>(null), latest = useRef(props), published = useRef(props.value); latest.current = props;
  const uploads = useRef(new Set<Promise<void>>()), composing = useRef(false), modeCompartment = useRef(new Compartment()), modeRef = useRef<MarkdownEditorMode>("live");
  const [mode, setMode] = useState<MarkdownEditorMode>("live"), [error, setError] = useState(""), [uploading, setUploading] = useState(0), [contextMenu, setContextMenu] = useState<ContextMenuState>(null), [imageEditor, setImageEditor] = useState<MarkdownImageContext | null>(null), [linkEditor, setLinkEditor] = useState<{ from: number; to: number; text: string; url: string } | null>(null);
  const imageFields = useRef({ alt: "", src: "", title: "", width: "" });
  const publish = (view = viewRef.current) => { if (!view || composing.current) return; const value = view.state.doc.toString(); if (value.length > 200_000) { setError("文档最多支持 200,000 字符。请撤销或删减后保存。"); return; } if (value !== published.current) { published.current = value; setError(""); latest.current.onChange(value); } };
  const dispatchEdit = (edit: { from: number; to: number; insert: string; selection: { from: number; to: number } }) => { const view = viewRef.current; if (!view) return; view.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, selection: EditorSelection.range(edit.selection.from, edit.selection.to), userEvent: "input" }); view.focus(); publish(view); };
  const runCommand = (command: MarkdownEditorCommand) => { const view = viewRef.current; if (!view) return; const range = view.state.selection.main; dispatchEdit(applyMarkdownCommand(view.state.doc.toString(), { from: range.from, to: range.to }, command)); setContextMenu(null); };
  const changeMode = (next: MarkdownEditorMode) => { const view = viewRef.current; if (!view || next === modeRef.current) return; modeRef.current = next; setMode(next); latest.current.onModeChange?.(next); view.dispatch({ effects: modeCompartment.current.reconfigure(next === "live" ? livePreview : []) }); view.contentDOM.setAttribute("aria-label", next === "source" ? "Markdown 源码" : "Markdown 正文"); view.focus(); };
  const uploadFiles = (files: File[], position?: number) => {
    const view = viewRef.current; if (!view || !files.length) return; const token = `<!-- piora-upload:${crypto.randomUUID()} -->`, range = view.state.selection.main, from = position ?? range.from;
    view.dispatch({ changes: { from, to: position === undefined ? range.to : from, insert: token }, selection: { anchor: from + token.length }, userEvent: "input" }); publish(view); setUploading((value) => value + files.length); setError("");
    const operation = (async () => { const markdown: string[] = [], failures: string[] = []; for (const file of files) { try { markdown.push(`![${file.name.replace(/[\[\]\\\r\n]/g, "_")}](${await latest.current.onImage(file)})`); } catch (cause) { failures.push(cause instanceof Error ? cause.message : String(cause)); } finally { setUploading((value) => Math.max(0, value - 1)); } } const current = viewRef.current; if (!current) return; const doc = current.state.doc.toString(), index = doc.indexOf(token); if (index >= 0) current.dispatch({ changes: { from: index, to: index + token.length, insert: markdown.join("\n\n") }, userEvent: "input" }); publish(current); if (failures.length) setError(failures.join("；")); })().finally(() => uploads.current.delete(operation)); uploads.current.add(operation);
  };
  useImperativeHandle(props.editorRef ?? ref, () => ({
    insert(before, after = "") { const view = viewRef.current; if (!view) return; const range = view.state.selection.main, text = view.state.sliceDoc(range.from, range.to); dispatchEdit({ from: range.from, to: range.to, insert: before + text + after, selection: { from: range.from + before.length, to: range.from + before.length + text.length } }); },
    focus: () => viewRef.current?.focus(), search: () => { if (viewRef.current) openSearchPanel(viewRef.current); }, jumpTo(offset) { const view = viewRef.current; if (!view) return; const safe = Math.max(0, Math.min(view.state.doc.length, offset)); view.dispatch({ selection: { anchor: safe }, effects: EditorView.scrollIntoView(safe, { y: "start", yMargin: 24 }) }); view.focus(); },
    async flush() { await Promise.all([...uploads.current]); publish(); return !composing.current && (viewRef.current?.state.doc.length ?? 0) <= 200_000; }, isBusy: () => uploads.current.size > 0 || composing.current || (viewRef.current?.state.doc.length ?? 0) > 200_000, setMode: changeMode, getMode: () => modeRef.current, command: runCommand,
  }));
  useEffect(() => {
    if (!host.current) return;
    const shortcuts: KeyBinding[] = [
      { key: "Mod-b", run: () => { runCommand("bold"); return true; } }, { key: "Mod-i", run: () => { runCommand("italic"); return true; } }, { key: "Mod-Shift-x", run: () => { runCommand("strike"); return true; } }, { key: "Mod-Shift-k", run: () => { runCommand("code"); return true; } },
      ...Array.from({ length: 6 }, (_, index): KeyBinding => ({ key: `Mod-${index + 1}`, run: () => { runCommand(`heading-${index + 1}` as MarkdownEditorCommand); return true; } })), { key: "Mod-0", run: () => { runCommand("paragraph"); return true; } }, { key: "Mod-s", run: () => { publish(); latest.current.onSave(); return true; } }, { key: "Mod-h", run: (view) => openSearchPanel(view) }, { key: "Mod-Alt-9", run: () => { changeMode(modeRef.current === "live" ? "source" : "live"); return true; } }, { key: "Enter", run: insertNewlineContinueMarkup },
    ];
    const state = EditorState.create({ doc: latest.current.value, extensions: [history(), lineNumbers(), highlightSpecialChars(), drawSelection(), dropCursor(), rectangularSelection(), highlightActiveLine(), EditorView.lineWrapping, markdown({ codeLanguages: languages }), syntaxHighlighting(defaultHighlightStyle, { fallback: true }), placeholder("从这里开始写作…"), editorTheme, modeCompartment.current.of(livePreview), keymap.of([...shortcuts, ...searchKeymap, ...markdownKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]), EditorView.contentAttributes.of({ "aria-label": "Markdown 正文", "aria-multiline": "true", role: "textbox", spellcheck: "true" }), EditorView.updateListener.of((update) => { if (update.docChanged) publish(update.view); if (update.docChanged || update.selectionSet) latest.current.onCursorChange?.(update.state.selection.main.head); if (latest.current.typewriter && (update.docChanged || update.selectionSet)) requestAnimationFrame(() => update.view.dispatch({ effects: EditorView.scrollIntoView(update.state.selection.main.head, { y: "center" }) })); }), EditorView.domEventHandlers({
      contextmenu(event, view) { event.preventDefault(); event.stopPropagation(); const position = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head, selected = view.state.selection.main; if (position < selected.from || position > selected.to) view.dispatch({ selection: { anchor: position } }); const doc = view.state.doc.toString(); setContextMenu({ x: event.clientX, y: event.clientY, position, table: Boolean(markdownTableAt(doc, position)), image: Boolean(markdownImageAt(doc, position)) }); return true; },
      paste(event, view) { const files = Array.from(event.clipboardData?.files ?? []); if (files.length) { event.preventDefault(); uploadFiles(files, view.state.selection.main.from); return true; } const html = event.clipboardData?.getData("text/html") ?? ""; if (!html) return false; event.preventDefault(); const value = clipboardHtmlToMarkdown(html); view.dispatch(view.state.replaceSelection(value)); publish(view); return true; },
      drop(event, view) { const files = Array.from(event.dataTransfer?.files ?? []); if (!files.length) return false; event.preventDefault(); event.stopPropagation(); uploadFiles(files, view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? undefined); return true; },
      compositionstart() { composing.current = true; return false; }, compositionend(_event, view) { composing.current = false; queueMicrotask(() => publish(view)); return false; },
    })] });
    const view = new EditorView({ state, parent: host.current }); viewRef.current = view; latest.current.onCursorChange?.(view.state.selection.main.head);
    const imageEvent = (event: Event) => { const position = (event as CustomEvent<{ position: number }>).detail.position, image = markdownImageAt(view.state.doc.toString(), position); if (!image) return; imageFields.current = { alt: image.alt, src: image.src, title: image.title, width: image.width ? String(image.width) : "" }; setImageEditor(image); };
    const contextEvent = (event: Event) => { const detail = (event as CustomEvent<{ x: number; y: number; position: number }>).detail, doc = view.state.doc.toString(); setContextMenu({ ...detail, image: Boolean(markdownImageAt(doc, detail.position)), table: Boolean(markdownTableAt(doc, detail.position)) }); };
    const tableCellEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ position: number; row: number; column: number; value: string; next?: { row: number; column: number } }>).detail;
      let table = markdownTableAt(view.state.doc.toString(), detail.position); if (!table) return;
      if (table.rows[detail.row]?.[detail.column] !== detail.value.trim()) { const edit = updateTableCell(table, detail.row, detail.column, detail.value); view.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, userEvent: "input" }); table = markdownTableAt(view.state.doc.toString(), edit.from)!; }
      if (detail.next && detail.next.row >= table.rows.length) { const edit = applyTableCommand({ ...table, row: table.rows.length - 1, column: detail.column }, "row-after"); view.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, userEvent: "input" }); table = markdownTableAt(view.state.doc.toString(), edit.from)!; }
      publish(view);
      if (detail.next) { const row = Math.min(detail.next.row, table.rows.length - 1), from = table.from; requestAnimationFrame(() => view.dom.querySelector<HTMLElement>(`.cm-md-table-wrap[data-table-from="${from}"] [data-row="${row}"][data-column="${detail.next!.column}"]`)?.focus()); }
    };
    view.dom.addEventListener("piora-markdown-image", imageEvent); view.dom.addEventListener("piora-markdown-context", contextEvent); view.dom.addEventListener("piora-markdown-table-cell", tableCellEvent);
    const dismiss = (event: MouseEvent) => { if (!(event.target instanceof Element) || !event.target.closest(".pocket-editor-context-menu")) setContextMenu(null); }, closeMenu = () => setContextMenu(null);
    window.addEventListener("mousedown", dismiss); window.addEventListener("blur", closeMenu); window.addEventListener("resize", closeMenu); window.addEventListener("scroll", closeMenu, true);
    return () => { publish(view); view.destroy(); viewRef.current = null; window.removeEventListener("mousedown", dismiss); window.removeEventListener("blur", closeMenu); window.removeEventListener("resize", closeMenu); window.removeEventListener("scroll", closeMenu, true); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (contextMenu) requestAnimationFrame(() => { const menu = menuRef.current; if (!menu) return; const margin = 8, bounds = menu.getBoundingClientRect(); menu.style.left = `${Math.max(margin, Math.min(contextMenu.x, window.innerWidth - bounds.width - margin))}px`; menu.style.top = `${Math.max(margin, Math.min(contextMenu.y, window.innerHeight - bounds.height - margin))}px`; menu.style.visibility = "visible"; menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus(); }); }, [contextMenu]);
  useEffect(() => { const view = viewRef.current; if (!view || props.value === published.current) return; published.current = props.value; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.value }, annotations: Transaction.addToHistory.of(false) }); }, [props.value]);
  const tableAction = (command: TableCommand) => { const view = viewRef.current, menu = contextMenu; if (!view || !menu) return; const table = markdownTableAt(view.state.doc.toString(), menu.position); if (table) { const edit = applyTableCommand(table, command), nextLength = view.state.doc.length - (edit.to - edit.from) + edit.insert.length, anchor = Math.min(nextLength, edit.from + edit.insert.length + 1); view.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, selection: { anchor }, userEvent: "input" }); publish(view); } setContextMenu(null); };
  const editImage = () => { const view = viewRef.current, menu = contextMenu; if (!view || !menu) return; const image = markdownImageAt(view.state.doc.toString(), menu.position); if (!image) return; imageFields.current = { alt: image.alt, src: image.src, title: image.title, width: image.width ? String(image.width) : "" }; setImageEditor(image); setContextMenu(null); };
  const editLink = () => { const view = viewRef.current; if (!view) return; const range = view.state.selection.main, doc = view.state.doc.toString(); let value = { from: range.from, to: range.to, text: doc.slice(range.from, range.to) || "链接文字", url: "https://" }; for (const match of doc.matchAll(/\[([^\]]+)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)/g)) { const from = match.index!, to = from + match[0].length; if ((range.from >= from && range.from <= to) || (contextMenu && contextMenu.position >= from && contextMenu.position <= to)) { value = { from, to, text: match[1], url: match[2] }; break; } } setLinkEditor(value); setContextMenu(null); };
  const clipboard = async (action: "copy" | "cut" | "paste" | "plain") => { const view = viewRef.current; if (!view) return; const range = view.state.selection.main; try { if (action === "copy" || action === "cut") { await navigator.clipboard.writeText(view.state.sliceDoc(range.from, range.to)); if (action === "cut" && !range.empty) view.dispatch({ changes: { from: range.from, to: range.to }, selection: { anchor: range.from }, userEvent: "delete.cut" }); } else { const value = await navigator.clipboard.readText(); view.dispatch(view.state.replaceSelection(value)); } publish(view); } catch { setError("无法访问剪贴板，请检查系统权限。"); } setContextMenu(null); view.focus(); };
  return <div className="pocket-markdown-editor" data-uploading={uploading > 0} data-mode={mode} data-focus-line={props.focusLine || undefined} data-typewriter={props.typewriter || undefined}>
    <div className="pocket-editor-menubar" role="toolbar" aria-label="Markdown 格式工具">
      <button type="button" onClick={() => viewRef.current && undo(viewRef.current)} title="撤销 · Ctrl+Z">↶</button><button type="button" onClick={() => viewRef.current && redo(viewRef.current)} title="重做 · Ctrl+Y">↷</button>
      <select aria-label="段落样式" defaultValue="paragraph" onChange={(event) => { runCommand(event.target.value as MarkdownEditorCommand); event.currentTarget.value = "paragraph"; }}><option value="paragraph">正文</option>{Array.from({ length: 6 }, (_, index) => <option key={index} value={`heading-${index + 1}`}>标题 {index + 1}</option>)}</select>
      <button type="button" onClick={() => runCommand("bold")} title="加粗 · Ctrl+B"><b>B</b></button><button type="button" onClick={() => runCommand("italic")} title="斜体 · Ctrl+I"><i>I</i></button><button type="button" onClick={() => runCommand("strike")} title="删除线"><s>S</s></button><button type="button" onClick={() => runCommand("code")} title="行内代码">&lt;/&gt;</button><button type="button" onClick={editLink} title="插入或编辑链接">链接</button><button type="button" onClick={() => runCommand("bullet-list")} title="无序列表">• 列表</button><button type="button" onClick={() => runCommand("task-list")} title="任务列表">☑</button><button type="button" onClick={() => runCommand("quote")} title="引用">❝</button><button type="button" onClick={() => runCommand("table")} title="插入表格">表格</button><button type="button" onClick={() => runCommand("math-block")} title="插入公式">公式</button>
      <select aria-label="更多格式" defaultValue="" onChange={(event) => { if (event.target.value) runCommand(event.target.value as MarkdownEditorCommand); event.currentTarget.value = ""; }}><option value="" disabled>更多</option><option value="ordered-list">有序列表</option><option value="highlight">高亮</option><option value="underline">下划线</option><option value="subscript">下标</option><option value="superscript">上标</option><option value="code-block">代码块</option><option value="horizontal-rule">分隔线</option></select>
      <label className="pocket-editor-upload" title="插入图片">图片<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => { uploadFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} /></label><span className="pocket-editor-spacer" /><button type="button" aria-pressed={mode === "live"} onClick={() => changeMode("live")}>即时排版</button><button type="button" aria-pressed={mode === "source"} onClick={() => changeMode("source")}>源码</button>
    </div>
    {uploading ? <p className="pocket-editor-notice" role="status">正在保存 {uploading} 张图片，可继续编辑…</p> : null}{error ? <p className="pocket-editor-notice" role="alert">{error}<button type="button" onClick={() => setError("")}>关闭</button></p> : null}<div ref={host} className="pocket-editor-host" />
    {contextMenu ? <div ref={menuRef} className="pocket-editor-context-menu" role="menu" aria-label="Markdown 编辑菜单" style={menuPosition(contextMenu.x, contextMenu.y)} onContextMenu={(event) => event.preventDefault()} onKeyDown={(event) => { const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')), index = items.indexOf(document.activeElement as HTMLButtonElement); if (event.key === "Escape") { event.preventDefault(); setContextMenu(null); viewRef.current?.focus(); } else if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus(); } else if (event.key === "Home") { event.preventDefault(); items[0]?.focus(); } else if (event.key === "End") { event.preventDefault(); items.at(-1)?.focus(); } }}>
      <MenuItem label="撤销" shortcut="Ctrl+Z" onClick={() => { if (viewRef.current) undo(viewRef.current); setContextMenu(null); }} /><MenuItem label="重做" shortcut="Ctrl+Y" onClick={() => { if (viewRef.current) redo(viewRef.current); setContextMenu(null); }} /><MenuSeparator /><MenuItem label="剪切" shortcut="Ctrl+X" onClick={() => void clipboard("cut")} /><MenuItem label="复制" shortcut="Ctrl+C" onClick={() => void clipboard("copy")} /><MenuItem label="粘贴" shortcut="Ctrl+V" onClick={() => void clipboard("paste")} /><MenuItem label="纯文本粘贴" shortcut="Ctrl+Shift+V" onClick={() => void clipboard("plain")} /><MenuItem label="全选" shortcut="Ctrl+A" onClick={() => { const view = viewRef.current; if (view) { view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }); view.focus(); } setContextMenu(null); }} /><MenuSeparator />
      {contextMenu.image ? <><MenuItem label="编辑图片…" onClick={editImage} /><MenuItem label="删除图片引用" onClick={() => { const view = viewRef.current!; const image = markdownImageAt(view.state.doc.toString(), contextMenu.position); if (image) dispatchEdit({ from: image.from, to: image.to, insert: "", selection: { from: image.from, to: image.from } }); setContextMenu(null); }} /><MenuSeparator /></> : null}
      {contextMenu.table ? <><MenuItem label="在上方插入行" onClick={() => tableAction("row-before")} /><MenuItem label="在下方插入行" onClick={() => tableAction("row-after")} /><MenuItem label="删除当前行" onClick={() => tableAction("row-delete")} /><MenuItem label="在左侧插入列" onClick={() => tableAction("column-before")} /><MenuItem label="在右侧插入列" onClick={() => tableAction("column-after")} /><MenuItem label="删除当前列" onClick={() => tableAction("column-delete")} /><MenuItem label="左对齐当前列" onClick={() => tableAction("align-left")} /><MenuItem label="居中当前列" onClick={() => tableAction("align-center")} /><MenuItem label="右对齐当前列" onClick={() => tableAction("align-right")} /><MenuSeparator /></> : null}
      {!contextMenu.image && !contextMenu.table ? <><MenuItem label="加粗" shortcut="Ctrl+B" onClick={() => runCommand("bold")} /><MenuItem label="斜体" shortcut="Ctrl+I" onClick={() => runCommand("italic")} /><MenuItem label="删除线" onClick={() => runCommand("strike")} /><MenuItem label="行内代码" onClick={() => runCommand("code")} /><MenuItem label="高亮" onClick={() => runCommand("highlight")} /><MenuItem label="链接" onClick={editLink} /><MenuSeparator /><MenuItem label="无序列表" onClick={() => runCommand("bullet-list")} /><MenuItem label="有序列表" onClick={() => runCommand("ordered-list")} /><MenuItem label="任务列表" onClick={() => runCommand("task-list")} /><MenuItem label="引用" onClick={() => runCommand("quote")} /></> : null}
    </div> : null}
    {imageEditor ? <div className="pocket-editor-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setImageEditor(null); }}><form className="pocket-editor-dialog" role="dialog" aria-modal="true" aria-label="编辑图片" onSubmit={(event) => { event.preventDefault(); dispatchEdit(updateMarkdownImage(imageEditor, { alt: imageFields.current.alt, src: imageFields.current.src, title: imageFields.current.title, width: Number(imageFields.current.width) || null })); setImageEditor(null); }}><h3>编辑图片</h3><label>图片地址<input defaultValue={imageFields.current.src} onChange={(event) => { imageFields.current.src = event.target.value; }} required /></label><label>替代文字<input defaultValue={imageFields.current.alt} onChange={(event) => { imageFields.current.alt = event.target.value; }} /></label><label>标题<input defaultValue={imageFields.current.title} onChange={(event) => { imageFields.current.title = event.target.value; }} /></label><label>宽度（像素）<input type="number" min="40" max="2400" placeholder="原始尺寸" defaultValue={imageFields.current.width} onChange={(event) => { imageFields.current.width = event.target.value; }} /></label><div><button type="button" onClick={() => setImageEditor(null)}>取消</button><button type="submit" className="primary">应用</button></div></form></div> : null}
    {linkEditor ? <div className="pocket-editor-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setLinkEditor(null); }}><form className="pocket-editor-dialog" role="dialog" aria-modal="true" aria-label="编辑链接" onSubmit={(event) => { event.preventDefault(); const text = linkEditor.text.trim() || linkEditor.url; const url = linkEditor.url.trim(); dispatchEdit({ from: linkEditor.from, to: linkEditor.to, insert: `[${text.replace(/[\[\]\r\n]/g, "_")}](${url.replace(/[\s)]/g, (character) => encodeURIComponent(character))})`, selection: { from: linkEditor.from + 1, to: linkEditor.from + 1 + text.length } }); setLinkEditor(null); }}><h3>插入或编辑链接</h3><label>显示文字<input autoFocus value={linkEditor.text} onChange={(event) => setLinkEditor({ ...linkEditor, text: event.target.value })} /></label><label>链接地址<input value={linkEditor.url} onChange={(event) => setLinkEditor({ ...linkEditor, url: event.target.value })} required /></label><div><button type="button" onClick={() => setLinkEditor(null)}>取消</button><button type="submit" className="primary">应用</button></div></form></div> : null}
  </div>;
});
function MenuItem({ label, shortcut, onClick }: { label: string; shortcut?: string; onClick(): void }) { return <button type="button" role="menuitem" onClick={onClick}><span>{label}</span>{shortcut ? <kbd>{shortcut}</kbd> : null}</button>; }
function MenuSeparator() { return <div className="pocket-editor-menu-separator" role="separator" />; }
