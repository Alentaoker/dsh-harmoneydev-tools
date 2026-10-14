import { getRoomMemberName, getRoomMemberSessionId, type CollaborationRoom } from "./room-types";

export function resolveExplicitRoomChatTargets(
  room: CollaborationRoom,
  content: string,
  options: { excludeSessionId?: string } = {},
): string[] {
  if (/(^|\s)@(所有人|all)(?=\s|$|[，,。.!！?？])/iu.test(content)) {
    return room.members
      .map(getRoomMemberSessionId)
      .filter((sessionId) => sessionId !== options.excludeSessionId);
  }
  const lowered = content.toLocaleLowerCase();
  return room.members.flatMap((member) => {
    const sessionId = getRoomMemberSessionId(member);
    const name = getRoomMemberName(member).trim();
    const index = name ? lowered.indexOf(`@${name.toLocaleLowerCase()}`) : -1;
    return name
      && sessionId !== options.excludeSessionId
      && index >= 0
      ? [{ sessionId, index }]
      : [];
  }).sort((left, right) => left.index - right.index).map(({ sessionId }) => sessionId);
}

export function resolveRoomChatTargets(room: CollaborationRoom, content: string): string[] {
  const mentioned = resolveExplicitRoomChatTargets(room, content);
  if (/(^|\s)@(所有人|all)(?=\s|$|[，,。.!！?？])/iu.test(content)) return mentioned;
  const coordinator = room.members.find((member) => member.memberId === room.coordination.coordinatorMemberId);
  if (mentioned.length > 1 && room.coordination.mode === "team" && coordinator) {
    return [getRoomMemberSessionId(coordinator)];
  }
  if (mentioned.length > 0) return mentioned;
  return [coordinator ? getRoomMemberSessionId(coordinator) : room.members[0] ? getRoomMemberSessionId(room.members[0]) : undefined]
    .filter((value): value is string => Boolean(value));
}
