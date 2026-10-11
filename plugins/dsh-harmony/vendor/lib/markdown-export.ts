import JSZip from "jszip";

const localImage = /\/api\/companion\/library\/image\?id=([a-zA-Z0-9_%.-]+)(?:&(?:amp;)?v=\d+)?/g;
const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/** Bundle only explicitly referenced local images. A missing attachment fails
 * the export visibly instead of producing a silently broken document. */
export async function exportMarkdown(title: string, markdown: string, readImage: (url: string) => Promise<Response> = fetch) {
  const filename = (title.trim() || "未命名文档").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "") || "未命名文档";
  const references = [...markdown.matchAll(localImage)];
  if (!references.length) return { filename: `${filename}.md`, blob: new Blob([markdown], { type: "text/markdown;charset=utf-8" }) };
  const zip = new JSZip();
  const paths = new Map<string, string>();
  for (const match of references) {
    const id = match[1];
    if (paths.has(id)) continue;
    const response = await readImage(`/api/companion/library/image?id=${id}`);
    if (!response.ok) throw new Error("有图片读取失败，请确认图片仍在中转站中，再重试导出。");
    const blob = await response.blob();
    const extension = extensions[blob.type];
    if (!extension || blob.size > 8 * 1024 * 1024) throw new Error("图片格式或大小不受支持，未导出不完整文档。");
    const name = `images/image-${paths.size + 1}.${extension}`;
    paths.set(id, name); zip.file(name, await blob.arrayBuffer());
  }
  zip.file(`${filename}.md`, markdown.replace(localImage, (_url, id: string) => paths.get(id)!));
  return { filename: `${filename}.zip`, blob: await zip.generateAsync({ type: "blob" }) };
}

function safeName(title: string) {
  return (title.trim() || "未命名文档").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "") || "未命名文档";
}

async function dataUrl(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return `data:${blob.type};base64,${btoa(binary)}`;
}

async function renderMermaidForBrowser(content: string) {
  if (typeof document === "undefined" || typeof DOMParser === "undefined") return content;
  const root = new DOMParser().parseFromString(`<body>${content}</body>`, "text/html").body;
  const blocks = Array.from(root.querySelectorAll("pre > code.language-mermaid"));
  if (!blocks.length) return content;
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: document.documentElement.dataset.theme === "dark" ? "dark" : "default" });
  for (const block of blocks) {
    try {
      const { svg } = await mermaid.render(`piora-export-${crypto.randomUUID()}`, block.textContent ?? "");
      const figure = root.ownerDocument.createElement("figure"); figure.className = "mermaid"; figure.innerHTML = svg; block.parentElement?.replaceWith(figure);
    } catch { /* Keep the fenced source visible when the diagram syntax is invalid. */ }
  }
  return root.innerHTML;
}

/** A portable, offline HTML document using the same safe GFM/math pipeline as reading mode. */
export async function exportHtml(title: string, markdown: string, readImage: (url: string) => Promise<Response> = fetch) {
  const [{ unified }, { default: remarkParse }, { default: remarkGfm }, { default: remarkMath }, { default: remarkRehype }, { default: rehypeRaw }, sanitizeModule, { default: rehypeKatex }, { default: rehypeStringify }] = await Promise.all([
    import("unified"), import("remark-parse"), import("remark-gfm"), import("remark-math"), import("remark-rehype"), import("rehype-raw"), import("rehype-sanitize"), import("rehype-katex"), import("rehype-stringify"),
  ]);
  const imageUrls = [...new Set([...markdown.matchAll(localImage)].map((match) => match[0].replace(/&amp;/g, "&")))];
  let portable = markdown;
  for (const url of imageUrls) {
    const response = await readImage(url);
    if (!response.ok) throw new Error("有图片读取失败，请确认图片仍在中转站中，再重试导出。");
    const blob = await response.blob();
    if (!extensions[blob.type] || blob.size > 8 * 1024 * 1024) throw new Error("图片格式或大小不受支持，未导出不完整文档。");
    const embedded = await dataUrl(blob);
    portable = portable.split(url).join(embedded).split(url.replace(/&/g, "&amp;")).join(embedded);
  }
  const schema = { ...sanitizeModule.defaultSchema, protocols: { ...sanitizeModule.defaultSchema.protocols, src: [...(sanitizeModule.defaultSchema.protocols?.src ?? []), "data"] } };
  const rendered = String(await unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkRehype, { allowDangerousHtml: true }).use(rehypeRaw).use(sanitizeModule.default, schema).use(rehypeKatex, { throwOnError: false, strict: false }).use(rehypeStringify).process(portable));
  const content = await renderMermaidForBrowser(rendered);
  const escapedTitle = title.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapedTitle}</title><style>body{max-width:820px;margin:0 auto;padding:48px 28px 80px;color:#242424;background:#fff;font:16px/1.85 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}h1,h2,h3{line-height:1.35;margin:1.5em 0 .65em}h2{border-bottom:1px solid #ddd;padding-bottom:.3em}blockquote{margin:1em 0;padding:.2em 1em;border-left:3px solid #777;color:#555}pre{overflow:auto;padding:16px;border-radius:7px;background:#f5f5f5}code{font-family:ui-monospace,monospace}p code{padding:.15em .35em;border-radius:4px;background:#f2f2f2}table{display:block;overflow:auto;width:100%;border-collapse:collapse}th,td{min-width:80px;padding:8px 11px;border:1px solid #d8d8d8}th{background:#f5f5f5}img,.mermaid svg{max-width:100%;height:auto}mark{background:#ffe78c}.katex-display,.mermaid{display:block;margin:1em 0;text-align:center}.katex-html{display:none}.katex-mathml{display:inline}@media print{body{max-width:none;padding:0}a{color:inherit;text-decoration:none}}</style></head><body>${content}</body></html>`;
  return { filename: `${safeName(title)}.html`, blob: new Blob([html], { type: "text/html;charset=utf-8" }) };
}
