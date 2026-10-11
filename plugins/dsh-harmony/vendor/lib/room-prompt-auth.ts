import { getActivePromptRun } from "./prompt-run-registry.ts";

export function assertSharedRoomReplyAllowed(sessionId: string, roomId: string): void {
  const prompt = getActivePromptRun(sessionId);
  if (prompt?.source === "room" && prompt.roomContext?.roomId === roomId) return;
  throw new Error(
    "Shared Room replies are only allowed while handling a message dispatched from that Room. Direct Session chats remain private.",
  );
}
