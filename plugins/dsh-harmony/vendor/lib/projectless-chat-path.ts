const PROJECTLESS_CHAT_PATH_SUFFIX = /[\\/]piora[\\/]projectless-chat-workspace[\\/]*$/i;

/**
 * Projectless chats still need a harmless cwd for the agent runtime. The
 * managed directory is identified by a stable suffix so sessions remain
 * projectless after the agent data directory is moved.
 */
export function isProjectlessChatCwd(cwd: string | null | undefined): boolean {
  return typeof cwd === "string" && PROJECTLESS_CHAT_PATH_SUFFIX.test(cwd.trim());
}
