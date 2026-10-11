import { getRoom } from "./room-store";
import { TeamError } from "./team-errors";
import type { CollaborationRoom, RoomMember } from "./room-types";

export function requireRoomMemberBySession(roomId: string, sessionId: unknown): { room: CollaborationRoom; member: RoomMember } {
  if (typeof sessionId !== "string" || !sessionId) throw new TeamError("TEAM_INVALID_INPUT", "sessionId is required.");
  let room: CollaborationRoom;
  try { room = getRoom(roomId); }
  catch { throw new TeamError("TEAM_ROOM_NOT_FOUND", "Room was not found."); }
  const member = room.members.find((candidate) => candidate.binding.sessionId === sessionId);
  if (!member) throw new TeamError("TEAM_INVALID_CONTEXT", "Session is not authorized for this Room.");
  return { room, member };
}

export function requireRoomCoordinatorBySession(roomId: string, sessionId: unknown): { room: CollaborationRoom; member: RoomMember } {
  const result = requireRoomMemberBySession(roomId, sessionId);
  if (result.member.memberId !== result.room.coordination.coordinatorMemberId) {
    throw new TeamError("TEAM_INVALID_CONTEXT", "Only the Room Coordinator can manage Team Agents.");
  }
  return result;
}
