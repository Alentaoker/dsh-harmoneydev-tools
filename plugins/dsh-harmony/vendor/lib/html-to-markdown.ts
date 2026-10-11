import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const safeLink = /^(?:https?:|mailto:|tel:|\/|#)/i;
const safeImage = /^(?:https?:|data:image\/(?:png|jpeg|webp|gif);base64,|\/)/i;

/** Convert clipboard HTML into portable GFM without carrying executable markup. */
export function clipboardHtmlToMarkdown(html: string) {
  const document = new DOMParser().parseFromString(html, "text/html");
  document.querySelectorAll("script,style,noscript,iframe,object,embed").forEach((element) => element.remove());
  document.querySelectorAll("a[href]").forEach((element) => { const href = element.getAttribute("href")?.trim() ?? ""; if (!safeLink.test(href)) element.removeAttribute("href"); });
  document.querySelectorAll("img[src]").forEach((element) => { const src = element.getAttribute("src")?.trim() ?? ""; if (!safeImage.test(src)) element.remove(); });
  const service = new TurndownService({ bulletListMarker: "-", codeBlockStyle: "fenced", emDelimiter: "*", strongDelimiter: "**" });
  service.use(gfm);
  return service.turndown(document.body).replace(/\n{3,}/g, "\n\n").trim();
}
