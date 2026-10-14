/** Serializable file references shared by the composer, drafts and send recovery. */
export interface AttachedFile {
  name: string;
  size: number;
  text: string | null;
  kind?: "file" | "paste";
  /** Absolute path on the machine running the agent. No file bytes enter the prompt. */
  path?: string;
}

export function buildLocalFilePrompt(message: string, files: AttachedFile[]): string {
  const localFiles = files.filter((file) => file.path);
  if (!localFiles.length) return message;
  const inventory = localFiles.map(({ name, size, path }) => JSON.stringify({ name, path, bytes: size })).join("\n");
  const attachmentPrompt = `The user attached these local files:\n${inventory}\nUse the available file tools to inspect their contents as needed, choosing a reader appropriate to each file format.`;
  return message ? `${message}\n\n${attachmentPrompt}` : attachmentPrompt;
}

export async function storeBrowserFiles(files: File[], names: string[]): Promise<AttachedFile[]> {
  const form = new FormData();
  files.forEach((file) => form.append("files", file));
  const response = await fetch("/api/prompt-files", { method: "POST", body: form });
  const body = await response.json().catch(() => ({})) as { files?: Array<{ path?: unknown }>; error?: string };
  if (!response.ok || !Array.isArray(body.files) || body.files.length !== files.length
    || body.files.some((file) => typeof file?.path !== "string" || !file.path)) {
    throw new Error(body.error || `Could not save attachments (HTTP ${response.status}).`);
  }
  return files.map((file, index) => ({ name: names[index], size: file.size, text: null, path: body.files![index].path as string }));
}
