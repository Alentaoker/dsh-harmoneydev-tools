import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { allowFileRoot } from "./allowed-roots";

export function getProjectlessChatWorkspace(): string {
  const cwd = resolve(join(getAgentDir(), "piora", "projectless-chat-workspace"));
  mkdirSync(cwd, { recursive: true });
  // The landing page asks for this workspace's model catalog before the first
  // session exists, so register it with the same filesystem trust boundary.
  allowFileRoot(cwd);
  return cwd;
}
