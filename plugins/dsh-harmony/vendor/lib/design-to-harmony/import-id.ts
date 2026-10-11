import { createHash } from "node:crypto";
import { resolve } from "node:path";

export function designImportId(projectRoot: string, provider: string, fileKey: string, nodeId: string | undefined, version: string): string {
  const projectKey = process.platform === "win32" ? resolve(projectRoot).toLowerCase() : resolve(projectRoot);
  const hash = createHash("sha256")
    .update(provider === "figma" ? "piora-design-import-v1\0" : "piora-design-import-v2\0")
    .update(projectKey)
    .update("\0");
  if (provider !== "figma") hash.update(provider).update("\0");
  const digest = hash.update(fileKey)
    .update("\0")
    .update(nodeId ?? "")
    .update("\0")
    .update(version)
    .digest("hex")
    .slice(0, 20);
  return `imp_${digest}`;
}
