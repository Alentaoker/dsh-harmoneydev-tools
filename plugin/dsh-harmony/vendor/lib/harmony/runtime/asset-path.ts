import { join } from "node:path";

/** External executables cannot read Electron's virtual ASAR paths. */
export function harmonyRuntimeAsset(...parts: string[]): string {
  const root = process.env.PIORA_WEB_RUNTIME_ROOT?.trim() || process.cwd();
  return join(root.endsWith(".asar") ? `${root}.unpacked` : root, ...parts);
}
