import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { MAX_ATTACHED_FILE_BYTES, MAX_PROMPT_MATERIAL_BYTES, MAX_PROMPT_MATERIAL_COUNT } from "./prompt-input-policy";
import type { AttachedFile } from "./file-attachments";

/** Preserve arbitrary file bytes for browser clients that cannot expose a local path. */
export async function savePromptFiles(files: File[], root = resolve(getAgentDir(), "piora", "prompt-files")): Promise<AttachedFile[]> {
  if (!files.length || files.length > MAX_PROMPT_MATERIAL_COUNT || files.some((file) => !(file instanceof File))) {
    throw new Error(`Provide between 1 and ${MAX_PROMPT_MATERIAL_COUNT} files.`);
  }
  if (files.some((file) => file.size > MAX_ATTACHED_FILE_BYTES)
    || files.reduce((sum, file) => sum + file.size, 0) > MAX_PROMPT_MATERIAL_BYTES) {
    throw new Error("Attachments must total 100 MiB or less.");
  }
  const directory = resolve(root, randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const saved: AttachedFile[] = [];
    for (const [index, file] of files.entries()) {
      // Prefix avoids Windows device names; retain the extension for format readers.
      const name = file.name.replaceAll("\\", "/").split("/").at(-1) || "attachment";
      const filename = `${index + 1}-${name.replace(/[\x00-\x1f<>:"/\\|?*]/g, "_").replace(/[. ]+$/, "").slice(-180) || "attachment"}`;
      const path = resolve(directory, filename);
      await writeFile(path, new Uint8Array(await file.arrayBuffer()), { mode: 0o600, flag: "wx" });
      saved.push({ name: file.name, size: file.size, text: null, path });
    }
    return saved;
  } catch (error) {
    // Only remove the freshly created UUID directory, never a supplied file path.
    if (resolve(directory, "..") !== resolve(root)) throw error;
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
