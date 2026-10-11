import type { RoomMessage } from "./room-types";

export function getRoomMessagePreview(message: RoomMessage): string {
  const author = message.author.name?.trim()
    || (message.author.kind === "user" ? "你" : message.author.kind === "system" ? "系统" : message.author.id);
  const content = message.content.replace(/\s+/gu, " ").trim();
  return `${author}：${content || "消息"}`;
}
