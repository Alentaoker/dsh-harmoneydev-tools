"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { markdownOutline } from "@/lib/markdown-outline";
import { MarkdownBody } from "./MarkdownBody";
import dynamic from "next/dynamic";
import type { CompanionLibraryItem } from "@/lib/companion-store";
import { createMarkdownDraft } from "@/lib/markdown-draft";
import { copyText } from "@/lib/clipboard";
import { AliIcon } from "./AliIcon";
import { CompanionStorageSettings } from "./CompanionStorageSettings";
import { TransferFileTree } from "./TransferFileTree";
import { TransferWorkspaceFrame, type TransferWorkspaceFrameHandle } from "./TransferWorkspaceFrame";
import { closeTransferTab, restoreTransferTabs, transferFolderPath, type TransferTabs } from "@/lib/transfer-workspace";
import type { MarkdownEditorHandle } from "./MarkdownEditor";
import type { JSZipObject } from "jszip";
import styles from "./CompanionTransferStation.module.css";

const MarkdownEditor = dynamic(() => import("./MarkdownEditor").then((module) => module.MarkdownEditor), { ssr: false, loading: () => <p role="status">正在打开编辑器…</p> });
type Write = (method: "POST" | "PATCH", input: unknown) => Promise<CompanionLibraryItem[]>;
interface Props {
  items: CompanionLibraryItem[]; loaded: boolean; loading: boolean; pending: boolean; error: string;
  write: Write; refresh: () => Promise<void>;
}

async function downloadMarkdown(title: string, content: string) {
  const { exportMarkdown } = await import("@/lib/markdown-export");
  const result = await exportMarkdown(title, content);
  downloadBlob(result.filename, result.blob);
}
function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function downloadHtml(title: string, content: string) {
  const { exportHtml } = await import("@/lib/markdown-export");
  const result = await exportHtml(title, content);
  downloadBlob(result.filename, result.blob);
}

async function imageData(file: File) {
  if (file.size > 8 * 1024 * 1024) throw new Error("单张图片不能超过 8 MB。");
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error("支持 PNG、JPEG、WebP 和 GIF 图片。");
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("图片读取失败。"));
    reader.readAsDataURL(file);
  });
}
const imageMarkdown = (item: CompanionLibraryItem) => `![${item.title.replace(/[\[\]\\]/g, "_")}](${item.content})`;
type ImportReview = { files: File[]; documents: number; images: number; archives: number };
type SizedZipEntry = JSZipObject & { _data?: { uncompressedSize?: number } };
const zipEntrySize = (entry: JSZipObject) => Number((entry as SizedZipEntry)._data?.uncompressedSize ?? 0);
const imageType = (name: string) => { const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase(); return extension === "png" ? "image/png" : extension === "jpg" || extension === "jpeg" ? "image/jpeg" : extension === "webp" ? "image/webp" : extension === "gif" ? "image/gif" : ""; };
function normalizeArchivePath(value: string) {
  let decoded = value.trim().replace(/\\/g, "/");
  try { decoded = decodeURIComponent(decoded); } catch { /* Keep literal names with invalid escapes. */ }
  const parts: string[] = [];
  for (const part of decoded.split("/")) { if (!part || part === ".") continue; if (part === "..") { if (!parts.length) return null; parts.pop(); } else parts.push(part); }
  return parts.join("/");
}
function imageReferences(content: string) {
  const references: string[] = [];
  for (const match of content.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)|<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi)) {
    const reference = (match[1] || match[2] || match[3] || "").trim();
    if (reference && !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(reference) && !references.includes(reference)) references.push(reference);
  }
  return references;
}
function archiveEntry(archive: { file(path: string): JSZipObject | null }, documentName: string, reference: string) {
  const direct = normalizeArchivePath(reference);
  const base = documentName.includes("/") ? documentName.slice(0, documentName.lastIndexOf("/") + 1) : "";
  const relative = normalizeArchivePath(`${base}${reference}`);
  return relative ? archive.file(relative) ?? (direct ? archive.file(direct) : null) : direct ? archive.file(direct) : null;
}

async function inspectImports(files: File[]): Promise<ImportReview> {
  let documents = 0, images = 0, archives = 0;
  for (const file of files) {
    if (/\.zip$/i.test(file.name)) {
      if (file.size > 32 * 1024 * 1024) throw new Error("ZIP 文件不能超过 32 MB。");
      const { default: JSZip } = await import("jszip"); const archive = await JSZip.loadAsync(await file.arrayBuffer()); const entries = Object.values(archive.files);
      if (entries.length > 500) throw new Error("ZIP 内文件过多，最多支持 500 个条目。");
      const markdown = entries.filter((entry) => !entry.dir && /\.(md|markdown)$/i.test(entry.name)); if (!markdown.length) throw new Error(`${file.name} 中没有 Markdown 文档。`);
      archives++;
      for (const document of markdown) { if (zipEntrySize(document) > 2 * 1024 * 1024) throw new Error(`${document.name} 文件过大。`); const content = await document.async("string"); if (content.length > 200_000) throw new Error(`${document.name} 超过 200,000 字符。`); documents++; for (const reference of imageReferences(content)) { const entry = archiveEntry(archive, document.name, reference); if (!entry) throw new Error(`ZIP 缺少文档引用的附件：${reference}`); if (!imageType(entry.name)) throw new Error(`ZIP 包含不支持的图片格式：${reference}`); if (zipEntrySize(entry) > 8 * 1024 * 1024) throw new Error(`ZIP 图片超过 8 MB：${reference}`); images++; } }
    } else if (file.type.startsWith("image/")) { if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 8 * 1024 * 1024) throw new Error(`${file.name} 不是受支持的图片或超过 8 MB。`); images++; }
    else { if (!/\.(md|markdown|txt)$/i.test(file.name)) throw new Error("请选择 .md、.markdown、.txt、ZIP 或图片文件。"); if (file.size > 2 * 1024 * 1024) throw new Error(`${file.name} 文件过大。`); const content = await file.text(); if (content.length > 200_000) throw new Error(`${file.name} 超过 200,000 字符。`); documents++; }
  }
  return { files, documents, images, archives };
}

function MarkdownDocument({ item, write, onCreated, onDeleted, registerSave }: { item: CompanionLibraryItem; write: Write; onCreated: (item: CompanionLibraryItem) => void; onDeleted: () => void; registerSave: (id: string, save: (() => Promise<boolean>) | null) => void }) {
  const [controller] = useState(() => createMarkdownDraft(item, async (value) => {
    const items = await write("PATCH", { id: item.id, ...value });
    const saved = items.find((entry) => entry.id === item.id);
    if (!saved) throw new Error("保存响应缺少文档，草稿已保留。");
    return saved;
  }, typeof window === "undefined" ? undefined : window.localStorage));
  const draft = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [preview, setPreview] = useState(false);
  const [outlineVisible, setOutlineVisible] = useState(false);
  const [outlineQuery, setOutlineQuery] = useState("");
  const [cursorOffset, setCursorOffset] = useState(0);
  const [focusLine, setFocusLine] = useState(false);
  const [typewriter, setTypewriter] = useState(false);
  const [editorMode, setEditorMode] = useState<"live" | "source">("live");
  const outline = useMemo(() => markdownOutline(draft.content), [draft.content]);
  const visibleOutline = useMemo(() => outline.filter((heading) => heading.title.toLocaleLowerCase().includes(outlineQuery.trim().toLocaleLowerCase())), [outline, outlineQuery]);
  const activeHeadingOffset = outline.reduce((active, heading) => heading.offset <= cursorOffset ? heading.offset : active, -1);
  const [notice, setNotice] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const editor = useRef<MarkdownEditorHandle>(null);
  const save = useCallback(async () => { if (await editor.current?.flush() === false) return false; return controller.save(); }, [controller]);
  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => controller.syncMetadata(item), [controller, item]);
  useEffect(() => { registerSave(item.id, save); return () => registerSave(item.id, null); }, [save, item.id, registerSave]);
  useEffect(() => {
    const flush = () => { if (document.visibilityState === "hidden") void save(); };
    const leave = (event: BeforeUnloadEvent) => { const current = controller.getSnapshot(); if (current.dirty || current.saving || editor.current?.isBusy()) event.preventDefault(); };
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("beforeunload", leave);
    return () => { document.removeEventListener("visibilitychange", flush); window.removeEventListener("beforeunload", leave); };
  }, [controller, save]);
  const action = async (run: () => Promise<void>) => {
    setActionPending(true); setNotice("");
    try { await run(); } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); }
    finally { setActionPending(false); }
  };
  const uploadImage = async (file: File) => {
    const items = await write("POST", { content: await imageData(file), title: file.name, kind: "image", parentId: item.parentId ?? null });
    if (!items[0]?.content) throw new Error("图片保存失败，请重试。");
    return items[0].content;
  };
  const remove = () => {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    void action(async () => {
      if (!await save()) return;
      await write("PATCH", { id: item.id, trash: true }); onDeleted();
    });
  };
  return <article className={styles.document} aria-label="Markdown 文档">
    <div className={styles.documentHeader}>
      <input className={styles.title} aria-label="文档标题" maxLength={120} placeholder="未命名文档" value={draft.title} onChange={(event) => controller.update({ title: event.target.value })} />
      <div className={styles.editorToolbar} role="toolbar" aria-label="文档视图">
        <button type="button" aria-pressed={outlineVisible} onClick={() => setOutlineVisible(!outlineVisible)}>大纲</button>
        <button type="button" title="查找与替换 · Ctrl+F / Ctrl+H" aria-label="查找与替换" disabled={preview} onClick={() => editor.current?.search()}><AliIcon name="search" size={14} /></button>
        <button type="button" aria-pressed={focusLine} onClick={() => setFocusLine(!focusLine)}>当前段落</button>
        <button type="button" aria-pressed={typewriter} onClick={() => setTypewriter(!typewriter)}>打字机</button>
        <button type="button" aria-pressed={preview} onClick={() => { void editor.current?.flush().then((ok) => { if (ok) setPreview(!preview); }); }}>{preview ? "编辑" : "阅读"}</button>
      </div>
      <div className={styles.documentActions}>
        <button type="button" title="导出 Markdown（有本机图片时打包为 ZIP）" aria-label="导出 Markdown" disabled={actionPending} onClick={() => void action(async () => { if (await editor.current?.flush() === false) return; const current = controller.getSnapshot(); await downloadMarkdown(current.title, current.content); })}><AliIcon name="download" size={15} /></button>
        <button type="button" title="导出可离线打开的 HTML" aria-label="导出 HTML" disabled={actionPending} onClick={() => void action(async () => { if (await editor.current?.flush() === false) return; const current = controller.getSnapshot(); await downloadHtml(current.title, current.content); })}>HTML</button>
        <button type="button" title="打印或保存为 PDF" aria-label="打印或保存 PDF" disabled={actionPending} onClick={() => void action(async () => { if (await editor.current?.flush() === false) return; setPreview(true); setTimeout(() => window.print(), 120); })}>PDF</button>
        <button type="button" title="复制 Markdown" aria-label="复制 Markdown" onClick={() => void action(async () => { if (await editor.current?.flush() === false) return; await copyText(controller.getSnapshot().content); setNotice("已复制 Markdown"); })}><AliIcon name="copy" size={15} /></button>
        <button type="button" title="创建当前文档的副本" aria-label="复制文档" disabled={actionPending} onClick={() => void action(async () => { if (await editor.current?.flush() === false) return; const current = controller.getSnapshot(); const result = await write("POST", { title: `${current.title || "未命名文档"}（副本）`, content: current.content, language: "markdown", parentId: item.parentId ?? null }); onCreated(result[0]); })}>副本</button>
        <button type="button" aria-label="删除文档" disabled={actionPending} onClick={remove}>{confirmDelete ? "确认删除" : <AliIcon name="delete" size={15} />}</button>
        {confirmDelete ? <button type="button" onClick={() => setConfirmDelete(false)}>取消</button> : null}
      </div>
    </div>
    <div className={styles.writingBody}>
      {outlineVisible ? <nav className={styles.outline} aria-label="文档大纲"><label className={styles.outlineSearch}><AliIcon name="search" size={13} /><input aria-label="筛选大纲" placeholder="筛选标题…" value={outlineQuery} onChange={(event) => setOutlineQuery(event.target.value)} /></label>{visibleOutline.length ? visibleOutline.map((heading) => <button type="button" key={heading.offset} title={heading.title} aria-current={heading.offset === activeHeadingOffset ? "location" : undefined} style={{ paddingLeft: 10 + (heading.level - 1) * 12 }} onClick={() => { setPreview(false); requestAnimationFrame(() => editor.current?.jumpTo(heading.offset)); }}>{heading.title || "无标题"}</button>) : <p>{outline.length ? "没有匹配的标题" : "使用 # 标题建立大纲"}</p>}</nav> : null}
      <div className={styles.writingContent}>
        <div hidden={preview} className={styles.editorMount}><MarkdownEditor editorRef={editor} value={draft.content} onChange={(content) => { controller.update({ content }); setNotice(""); }} onSave={() => { void save(); }} onImage={uploadImage} focusLine={focusLine} typewriter={typewriter} onModeChange={setEditorMode} onCursorChange={setCursorOffset} /></div>
        {preview ? <div className={styles.readingPreview}><MarkdownBody>{draft.content}</MarkdownBody></div> : null}
      </div>
    </div>
    <footer className={styles.documentStatus}>
      <span role={draft.error ? "alert" : "status"}>{draft.error || notice || (draft.saving ? "正在保存…" : draft.dirty ? draft.recovered ? "已恢复未保存草稿" : "尚未保存" : "已保存到本机")}</span>
      {draft.error ? <button type="button" disabled={actionPending} onClick={() => void action(async () => {
        const items = await write("POST", { title: `${draft.title || "未命名文档"}（副本）`, content: draft.content, language: "markdown", parentId: item.parentId ?? null }); onCreated(items[0]);
      })}>另存副本</button> : null}
      {draft.dirty ? <button type="button" disabled={draft.saving} onClick={() => void save()}>保存</button> : null}
      <small>{draft.content.length.toLocaleString()} 字符 · {editorMode === "live" ? "即时排版" : "Markdown 源码"}</small>
    </footer>
  </article>;
}

export function CompanionTransferStation({ items, loaded, loading, pending, error, write, refresh }: Props) {
  const [tabs, setTabs] = useState<TransferTabs>({ ids: [], activeId: null });
  const [restored, setRestored] = useState(false);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [writingWidth, setWritingWidth] = useState(820);
  const [writingMode, setWritingMode] = useState<"fluid" | "fixed">("fluid");
  const [writingSize, setWritingSize] = useState(16);
  const [writingSizeDraft, setWritingSizeDraft] = useState("16");
  useEffect(() => { setWritingSizeDraft(String(writingSize)); }, [writingSize]);
  const [focusMode, setFocusMode] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [purgeId, setPurgeId] = useState<string | null>(null);
  const [importReview, setImportReview] = useState<ImportReview | null>(null);
  const widthRef = useRef(210);
  const stationRef = useRef<HTMLDivElement>(null);
  const workspaceFrame = useRef<TransferWorkspaceFrameHandle>(null);
  const sidebarResize = useResizablePanel({ ariaLabel: "调整文件列表宽度", cssVariable: "--transfer-sidebar-width", defaultWidth: 210, minWidth: 130, maxWidth: 420,
    getMaxWidth: () => Math.max(130, Math.min(420, (stationRef.current?.clientWidth ?? 800) * .45)), growthDirection: "right", storageKey: "piora:transfer-sidebar-width:v1", widthRef, panelRef: stationRef });
  useEffect(() => { try { const saved = JSON.parse(localStorage.getItem("piora:transfer-writing:v1") ?? "null"); if (saved) { if (Number.isFinite(saved.width)) setWritingWidth(Math.max(420, Math.min(1400, saved.width))); if (Number.isFinite(saved.size)) setWritingSize(Math.max(10, Math.min(48, Math.round(saved.size)))); setWritingMode(saved.mode === "fixed" || (saved.mode === undefined && Number.isFinite(saved.width) && saved.width !== 820) ? "fixed" : "fluid"); } } catch { /* Optional layout. */ } }, []);
  const updateWriting = (width: number, size: number, mode = writingMode) => { size = Number.isFinite(size) ? Math.max(10, Math.min(48, Math.round(size))) : 16; setWritingWidth(width); setWritingSize(size); setWritingMode(mode); try { localStorage.setItem("piora:transfer-writing:v1", JSON.stringify({ width, size, mode })); } catch { /* Layout still works. */ } };
  const saves = useRef(new Map<string, () => Promise<boolean>>());
  const closing = useRef(new Set<string>());
  const registerSave = useCallback((id: string, save: (() => Promise<boolean>) | null) => { if (save) saves.current.set(id, save); else saves.current.delete(id); }, []);
  const input = useRef<HTMLInputElement>(null);
  const activeItems = useMemo(() => items.filter((item) => !item.deletedAt), [items]);
  const trashedItems = useMemo(() => items.filter((item) => item.deletedAt), [items]);
  const selected = activeItems.find((item) => item.id === tabs.activeId && item.kind !== "folder");
  const documents = tabs.ids.flatMap((id) => { const item = activeItems.find((item) => item.id === id && item.kind !== "folder"); return item ? [item] : []; });
  useEffect(() => {
    if (!loaded || !restored) return;
    setTabs((current) => {
      const next = restoreTransferTabs(current, activeItems);
      return next.activeId === current.activeId && next.ids.length === current.ids.length ? current : next;
    });
    if (folderId && !activeItems.some((item) => item.id === folderId && item.kind === "folder")) setFolderId(null);
  }, [activeItems, loaded, restored, folderId]);
  useEffect(() => {
    if (!loaded || restored) return;
    let saved: unknown = null;
    try { saved = JSON.parse(localStorage.getItem("piora:transfer-tabs:v1") ?? "null"); } catch { /* Optional UI state. */ }
    setTabs(restoreTransferTabs(saved, activeItems)); setRestored(true);
  }, [activeItems, loaded, restored]);
  useEffect(() => {
    if (!restored) return;
    try { localStorage.setItem("piora:transfer-tabs:v1", JSON.stringify(tabs)); } catch { /* Editing stays available. */ }
  }, [restored, tabs]);
  const open = (item: CompanionLibraryItem) => {
    if (item.kind === "folder") { setFolderId(item.id); return; }
    setTabs((current) => ({ ids: current.ids.includes(item.id) ? current.ids : [...current.ids, item.id], activeId: item.id }));
    setFolderId(item.parentId ?? null); setNotice("");
  };
  const close = async (id: string) => {
    if (closing.current.has(id)) return;
    closing.current.add(id);
    try {
      const save = saves.current.get(id);
      if (save && !await save()) { setTabs((current) => ({ ...current, activeId: id })); setNotice("文档尚未保存，已保留标签页。请重试保存或另存副本。"); return; }
      setTabs((current) => closeTransferTab(current, id));
    } finally { closing.current.delete(id); }
  };
  const mutateFolder = async (method: "POST" | "PATCH", value: unknown) => {
    setBusy(true);
    try { const result = await write(method, value); setNotice(""); return result; }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); return null; }
    finally { setBusy(false); }
  };
  const move = async (id: string, parentId: string | null) => {
    const save = saves.current.get(id);
    if (save && !await save()) { setNotice("请先保存文档，再移动文件。"); return; }
    const result = await mutateFolder("PATCH", { id, parentId });
    if (result) { setFolderId(parentId); setTabs((current) => ({ ...current })); }
  };
  const deleteFile = async (id: string): Promise<boolean> => {
    if (busy || pending || closing.current.has(id)) return false;
    closing.current.add(id); setBusy(true); setNotice("");
    try {
      const save = saves.current.get(id);
      if (save && !await save()) { setNotice("文档尚未保存，未删除文件。请先保存或另存副本。"); return false; }
      await write("PATCH", { id, trash: true });
      setTabs((current) => closeTransferTab(current, id));
      return true;
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { closing.current.delete(id); setBusy(false); }
  };
  const create = async (title = "未命名文档", content = "") => {
    setBusy(true);
    try { const result = await write("POST", { title, content, language: "markdown", parentId: folderId }); open(result[0]); }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const prepareImport = async (files: File[]) => {
    if (!files.length) return;
    setImportReview(null); setBusy(true); setNotice("");
    try { const review = await inspectImports(files); if (items.length + review.documents + review.images > 200) throw new Error("导入后会超过中转站 200 条容量，请先清理回收站或减少文件。"); setImportReview(review); }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const importFiles = async (files: File[]) => {
    setBusy(true); const createdIds: string[] = [];
    try {
      for (const file of files) {
        if (/\.zip$/i.test(file.name)) {
          if (file.size > 32 * 1024 * 1024) throw new Error("ZIP 文件不能超过 32 MB。");
          const { default: JSZip } = await import("jszip");
          const archive = await JSZip.loadAsync(await file.arrayBuffer());
          const entries = Object.values(archive.files);
          if (entries.length > 500) throw new Error("ZIP 内文件过多，最多支持 500 个条目。");
          const documents = entries.filter((entry) => !entry.dir && /\.(md|markdown)$/i.test(entry.name));
          if (!documents.length) throw new Error("ZIP 中没有 Markdown 文档。");
          for (const document of documents) {
            if (zipEntrySize(document) > 2 * 1024 * 1024) throw new Error(`${document.name} 文件过大。`);
            let content = await document.async("string");
            if (content.length > 200_000) throw new Error(`${document.name} 超过 200,000 字符，未导入。`);
            const references = imageReferences(content);
            for (const reference of references) {
              const entry = archiveEntry(archive, document.name, reference);
              if (!entry) throw new Error(`ZIP 缺少文档引用的附件：${reference}`);
              const type = imageType(entry.name);
              if (!type) throw new Error(`ZIP 包含不支持的图片格式：${reference}`);
              const bytes = await entry.async("arraybuffer"); if (bytes.byteLength > 8 * 1024 * 1024) throw new Error(`ZIP 图片超过 8 MB：${reference}`);
              const image = new File([bytes], entry.name.split("/").at(-1) || "image", { type });
              const result = await write("POST", { title: image.name, content: await imageData(image), kind: "image", parentId: folderId });
              createdIds.push(result[0].id);
              content = content.split(reference).join(result[0].content);
            }
            const result = await write("POST", { title: document.name.split("/").at(-1)!.replace(/\.(md|markdown)$/i, ""), content, language: "markdown", parentId: folderId }); createdIds.push(result[0].id); open(result[0]);
          }
        } else if (file.type.startsWith("image/")) {
          const result = await write("POST", { title: file.name, content: await imageData(file), kind: "image", parentId: folderId }); createdIds.push(result[0].id); open(result[0]);
        } else {
          if (!/\.(md|markdown|txt)$/i.test(file.name)) throw new Error("请选择 .md、.markdown、.txt、ZIP 或图片文件。");
          if (file.size > 2 * 1024 * 1024) throw new Error("文档文件过大，最多支持 200,000 字符。");
          const content = await file.text();
          if (content.length > 200_000) throw new Error("文档最多支持 200,000 字符。");
          const result = await write("POST", { title: file.name.replace(/\.(md|markdown|txt)$/i, ""), content, language: "markdown", parentId: folderId }); createdIds.push(result[0].id); open(result[0]);
        }
      }
    } catch (cause) {
      let rollbackFailed = false;
      for (const id of [...createdIds].reverse()) { try { await write("PATCH", { id, remove: true }); } catch { rollbackFailed = true; } }
      setTabs((current) => ({ ids: current.ids.filter((id) => !createdIds.includes(id)), activeId: createdIds.includes(current.activeId ?? "") ? null : current.activeId }));
      const rollback = !createdIds.length ? "" : rollbackFailed ? " 部分已创建内容未能自动撤销，请在回收站中检查。" : " 已撤销本次已创建的内容。";
      setNotice(`${cause instanceof Error ? cause.message : String(cause)}${rollback}`);
    }
    finally { setBusy(false); }
  };
  return <section className={styles.station} aria-label="中转站" onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={(event) => {
    if (!event.dataTransfer.files.length) return;
    if (event.target instanceof Element && event.target.closest(".pocket-markdown-editor")) return;
    event.preventDefault(); void prepareImport(Array.from(event.dataTransfer.files));
  }}>
    <header className={styles.heading}>
      <div><h1>中转站 <span>Markdown</span></h1></div>
      <div className={styles.headingActions}>
        <button type="button" aria-label="铺满中转站工作区" title="恢复工作区为随窗口自适应大小" onClick={() => workspaceFrame.current?.resetSize()}>铺满工作区</button>
        <button type="button" aria-expanded={layoutOpen} onClick={() => setLayoutOpen(!layoutOpen)}>字号与版式</button>
        <button type="button" aria-pressed={focusMode} onClick={() => setFocusMode(!focusMode)}>{focusMode ? "退出专注" : "专注"}</button>
        <button type="button" disabled={busy || pending || !loaded} onClick={() => input.current?.click()}>导入</button>
        <button type="button" aria-pressed={trashOpen} onClick={() => { setTrashOpen(!trashOpen); setPurgeId(null); }}>回收站{trashedItems.length ? ` ${trashedItems.length}` : ""}</button>
        <button className={styles.primary} type="button" disabled={busy || pending || !loaded} onClick={() => void create()}><AliIcon name="plus" size={14} />新建</button>
        <button type="button" aria-label="中转站存储位置" aria-expanded={settings} onClick={() => setSettings(!settings)}><AliIcon name="setting" size={16} /></button>
      </div>
    </header>
    <input ref={input} hidden type="file" accept=".md,.markdown,.txt,.zip,image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => { void prepareImport(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
    {importReview ? <div className={styles.importBackdrop} onKeyDown={(event) => { if (event.key === "Escape" && !busy) setImportReview(null); }} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setImportReview(null); }}><section className={styles.importDialog} role="dialog" aria-modal="true" aria-label="确认导入"><h2>确认导入</h2><p>已检查 {importReview.files.length} 个选择项{importReview.archives ? `，其中 ${importReview.archives} 个 ZIP` : ""}。</p><dl><div><dt>Markdown 文档</dt><dd>{importReview.documents}</dd></div><div><dt>图片与附件</dt><dd>{importReview.images}</dd></div><div><dt>将占用条目</dt><dd>{importReview.documents + importReview.images}</dd></div></dl><div><button type="button" disabled={busy} onClick={() => setImportReview(null)}>取消</button><button type="button" className={styles.primary} disabled={busy} autoFocus onClick={() => { const files = importReview.files; setImportReview(null); void importFiles(files); }}>确认导入</button></div></section></div> : null}
    {settings ? <CompanionStorageSettings scope="library" compact /> : null}
    {layoutOpen ? <div className={styles.layoutControls}>
      <div className={styles.widthModes} role="group" aria-label="正文布局"><button type="button" aria-pressed={writingMode === "fluid"} onClick={() => updateWriting(writingWidth, writingSize, "fluid")}>自适应宽度</button><button type="button" aria-pressed={writingMode === "fixed"} onClick={() => updateWriting(writingWidth, writingSize, "fixed")}>固定栏宽</button></div>
      {writingMode === "fixed" ? <label>正文宽度 <input type="range" min="420" max="1400" step="20" value={writingWidth} onChange={(event) => updateWriting(Number(event.target.value), writingSize)} /><output>{writingWidth} px</output></label> : null}
      <label>字号 <input type="range" min="10" max="48" value={writingSize} onChange={(event) => updateWriting(writingWidth, Number(event.target.value))} /></label>
      <label>自定义字号 <input className={styles.fontSizeInput} type="number" min="10" max="48" step="1" inputMode="numeric" value={writingSizeDraft}
        onChange={event => { const value = event.currentTarget.value; setWritingSizeDraft(value); if (value !== "" && Number(value) >= 10 && Number(value) <= 48) updateWriting(writingWidth, Number(value)); }}
        onBlur={() => { const next = writingSizeDraft.trim() === "" ? writingSize : Math.max(10, Math.min(48, Math.round(Number(writingSizeDraft)))); updateWriting(writingWidth, Number.isFinite(next) ? next : writingSize); setWritingSizeDraft(String(Number.isFinite(next) ? next : writingSize)); }}
        onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />px</label>
      <button type="button" onClick={() => { sidebarResize.resetWidth(); workspaceFrame.current?.resetSize(); updateWriting(820, 16, "fluid"); }}>恢复默认</button><span>{writingMode === "fluid" ? "正文随编辑区宽度自动伸展" : "正文居中，保留舒适的阅读栏宽"}</span>
    </div> : null}
    {error || notice ? <div className={styles.error} role="alert"><span>{notice || error}</span><button type="button" onClick={() => { setNotice(""); void refresh().catch(() => {}); }}>重试</button></div> : null}
    <TransferWorkspaceFrame ref={workspaceFrame} expanded={focusMode}>
    <div ref={stationRef} className={styles.workspace} data-focus={focusMode} data-writing-layout={writingMode} style={{ "--writing-width": writingMode === "fluid" ? "100%" : `${writingWidth}px`, "--writing-size": `${writingSize}px` } as CSSProperties}>
      {trashOpen ? <section className={styles.trashPane} aria-label="中转站回收站"><header><div><h2>回收站</h2><p>删除的内容仍计入中转站容量，可恢复或永久删除。</p></div><button type="button" onClick={() => setTrashOpen(false)}>返回文档</button></header><div className={styles.trashList}>{trashedItems.map((item) => <div key={item.id}><AliIcon name={item.kind === "image" ? "attachment" : item.kind === "folder" ? "folder" : "file"} size={16} /><span><strong>{item.title || "未命名文档"}</strong><small>{item.deletedAt ? new Date(item.deletedAt).toLocaleString() : ""}</small></span><button type="button" disabled={busy || pending} onClick={() => void mutateFolder("PATCH", { id: item.id, restore: true }).then((result) => { if (result) setPurgeId(null); })}>恢复</button><button type="button" disabled={busy || pending} onClick={() => { if (purgeId !== item.id) { setPurgeId(item.id); return; } void mutateFolder("PATCH", { id: item.id, remove: true }).then((result) => { if (result) setPurgeId(null); }); }}>{purgeId === item.id ? "确认永久删除" : "永久删除"}</button></div>)}{!trashedItems.length ? <p>回收站为空</p> : null}</div></section> : null}
      {sidebarVisible ? <TransferFileTree items={activeItems} selectedId={selected?.id ?? null} folderId={folderId} query={query} onQuery={setQuery} onOpen={open} onFolder={setFolderId} disabled={busy || pending || !loaded}
        onDeleteFile={deleteFile}
        onMove={(id, parentId) => { void move(id, parentId); }}
        onCreateFolder={async (title) => { const result = await mutateFolder("POST", { title, content: "", kind: "folder", parentId: folderId }); if (result) setFolderId(result[0].id); return Boolean(result); }}
        onRenameFolder={async (title) => Boolean(await mutateFolder("PATCH", { id: folderId, title }))}
        onDeleteFolder={() => { void mutateFolder("PATCH", { id: folderId, trash: true }).then((result) => { if (result) setFolderId(null); }); }} /> : null}
      {sidebarVisible && !focusMode ? <div className={styles.resizeHandle} {...sidebarResize.separatorProps} /> : null}
      <div className={styles.editorArea}>
      <div className={styles.tabBar}>
        <button type="button" aria-label={sidebarVisible ? "隐藏文件列表" : "显示文件列表"} title={sidebarVisible ? "隐藏文件列表" : "显示文件列表"} aria-expanded={sidebarVisible} onClick={() => setSidebarVisible(!sidebarVisible)}><AliIcon name="folder" size={15} /></button>
        <div className={styles.fileTabs} role="tablist" aria-label="中转站文件" onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
          const index = tabs.indexOf(event.target as HTMLButtonElement);
          if (index < 0 || !tabs.length) return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
          tabs[next].click(); tabs[next].focus();
        }}>{documents.map((item) => <div className={styles.fileTabGroup} data-active={selected?.id === item.id} key={item.id} draggable onDragStart={(event) => { event.dataTransfer.setData("application/x-piora-transfer-tab", item.id); event.dataTransfer.effectAllowed = "move"; }} onDragOver={(event) => { if (event.dataTransfer.types.includes("application/x-piora-transfer-tab")) event.preventDefault(); }} onDrop={(event) => { const moving = event.dataTransfer.getData("application/x-piora-transfer-tab"); if (!moving || moving === item.id) return; event.preventDefault(); setTabs((current) => { const ids = current.ids.filter((id) => id !== moving); ids.splice(ids.indexOf(item.id), 0, moving); return { ...current, ids }; }); }}><button type="button" role="tab" className={styles.fileTab}
          id={`transfer-tab-${item.id}`} aria-controls={`transfer-pane-${item.id}`} aria-selected={selected?.id === item.id} tabIndex={selected?.id === item.id || !documents.some((entry) => entry.id === selected?.id) ? 0 : -1}
          title={item.title || "未命名文档"} onClick={(event) => { open(item); event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" }); }}>
          <AliIcon name={item.kind === "image" ? "attachment" : "file"} size={14} /><span>{item.title || "未命名文档"}</span>
        </button><button type="button" className={styles.tabClose} aria-label={`关闭 ${item.title || "未命名文档"}`} title="关闭标签页" onClick={() => { void close(item.id); }}><AliIcon name="close" size={12} /></button></div>)}{!documents.length ? <span className={styles.listEmpty}>{loading ? "正在加载…" : "未打开文档"}</span> : null}</div>
        {documents.length ? <select className={styles.openTabsMenu} aria-label="所有已打开的标签页" title="所有已打开的标签页" value={selected?.id ?? ""} onChange={(event) => { const item = activeItems.find((item) => item.id === event.target.value); if (item) open(item); }}><option value="" disabled>已打开</option>{documents.map((item) => <option key={item.id} value={item.id}>{item.title || "未命名文档"}</option>)}</select> : null}
      </div>
      <div className={styles.breadcrumb}>中转站{folderId ? ` / ${transferFolderPath(activeItems, folderId)}` : ""}{selected ? ` / ${selected.title}` : ""}
        {selected ? <select aria-label="移动当前文件到文件夹" value={selected.parentId ?? ""} disabled={pending || busy} onChange={(event) => { void move(selected.id, event.target.value || null); }}><option value="">根目录</option>{activeItems.filter((item) => item.kind === "folder").map((item) => <option key={item.id} value={item.id}>{transferFolderPath(activeItems, item.id)}</option>)}</select> : null}
      </div>
      {documents.map((item) => <div key={item.id} className={styles.tabPane} role="tabpanel" id={`transfer-pane-${item.id}`} aria-labelledby={`transfer-tab-${item.id}`} hidden={item.id !== selected?.id}>
        {item.kind === "image" ? <article className={styles.imageDocument}>
          <h2>{item.title}</h2><div className={styles.largeImage} role="img" aria-label={item.title} style={{ backgroundImage: `url(${JSON.stringify(item.content)})` }} />
          <a href={item.content} download={item.title}>保存图片</a>
          <button type="button" onClick={() => void copyText(imageMarkdown(item)).then(() => setNotice("已复制图片 Markdown，可粘贴到文档中。")).catch(() => setNotice("复制失败"))}>复制 Markdown</button>
          <button type="button" disabled={pending} onClick={() => void write("PATCH", { id: item.id, trash: true }).then(() => setTabs((current) => closeTransferTab(current, item.id))).catch((cause) => setNotice(String(cause)))}>删除图片</button>
        </article> : <MarkdownDocument item={item} write={write} onCreated={open} registerSave={registerSave} onDeleted={() => setTabs((current) => closeTransferTab(current, item.id))} />}
      </div>)}
      {!selected ? <div className={styles.empty}>
        <AliIcon name="file" size={32} /><h2>{!loaded && error ? "暂时无法打开文档" : loading ? "正在打开中转站…" : "留一页，给此刻的想法"}</h2>
        <p>支持 Markdown 即时排版与自动保存。<br />也可以将文档或图片拖到这里。</p>
        <button className={styles.primary} type="button" disabled={busy || !loaded} onClick={() => void create()}>新建文档</button>
      </div> : null}
      </div>
    </div>
    </TransferWorkspaceFrame>
  </section>;
}
