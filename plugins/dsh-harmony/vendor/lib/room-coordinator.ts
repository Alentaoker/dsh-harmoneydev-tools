import {
  claimRoomTask,
  getRoom,
  listRoomTasks,
  releaseRoomTaskLease,
} from "./room-store";
import { getSessionMessageRouter, type SessionMessageRouterError } from "./session-message-router";
import type { RoomMember, RoomTask } from "./room-types";

export interface RoomDispatchResult {
  dispatched: Array<{ taskId: string; sessionId: string; commandId: string; status: string }>;
  skipped: Array<{ taskId: string; reason: string; code?: string }>;
}

function candidateMembers(room: ReturnType<typeof getRoom>, task: RoomTask): RoomMember[] {
  const ordered = [...room.members].sort((left, right) => {
    const rank = (member: RoomMember) => ({ worker: 0, participant: 1, planner: 2, reviewer: 3, coordinator: 4 })[member.role];
    return rank(left) - rank(right) || left.joinedAt - right.joinedAt;
  });
  return task.assignedTo ? ordered.filter((member) => member.sessionId === task.assignedTo) : ordered;
}

async function dispatchTask(roomId: string, task: RoomTask, member: RoomMember): Promise<{ commandId: string; status: string }> {
  const room = getRoom(roomId);
  const claimed = claimRoomTask(roomId, task.id, member.sessionId);
  const router = getSessionMessageRouter();
  try {
    const receipt = await router.dispatchSessionMessage({
      targetSessionId: member.sessionId,
      source: "room",
      roomContext: { roomId, messageId: claimed.id },
      delivery: "next_turn",
      idempotencyKey: `${roomId}:${claimed.id}:${member.sessionId}:${claimed.attempt}`,
      content: [
        "[PIORA COORDINATOR TASK]",
        `Room ID: ${roomId}`,
        `Task ID: ${claimed.id}`,
        `Lease token: ${claimed.lease!.token}`,
        `Title: ${claimed.title}`,
        `Description: ${claimed.description}`,
        `Your team identity: ${member.name || member.sessionId} (${member.role})`,
        `Your responsibility: ${member.instructions || "Complete the assigned task and report reusable results."}`,
        `Shared workspace: ${room.workspace.path}`,
        `Workspace contract: ${room.workspace.instructions || "Avoid overwriting another Agent's active work."}`,
        `Workspace: ${claimed.workspace?.cwd ?? member.cwd ?? "unknown"}`,
        `Worktree branch: ${claimed.workspace?.worktreeBranch ?? member.worktreeBranch ?? "main/unknown"}`,
        "Work only on this leased task. Use piora_room heartbeat_task during long work, then complete_task, fail_task, or block_task with the exact lease token. Broadcast reusable results to the room.",
      ].join("\n"),
    });
    return { commandId: receipt.commandId, status: receipt.status };
  } catch (error) {
    releaseRoomTaskLease(roomId, claimed.id, member.sessionId, claimed.lease!.token, `Dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

export async function dispatchReadyRoomTasks(roomId: string): Promise<RoomDispatchResult> {
  const room = getRoom(roomId);
  if (room.coordination.mode !== "team") throw new Error("Coordinator mode is not enabled for this room.");
  const result: RoomDispatchResult = { dispatched: [], skipped: [] };
  const busyMembers = new Set(
    listRoomTasks(roomId)
      .filter((task) => task.status === "leased" || task.status === "running")
      .map((task) => task.assignedTo)
      .filter((id): id is string => Boolean(id)),
  );
  const pending = listRoomTasks(roomId).filter((task) => task.status === "pending");
  const selected: Array<{ task: RoomTask; member: RoomMember }> = [];
  for (const task of pending) {
    const member = candidateMembers(room, task).find((candidate) => !busyMembers.has(candidate.sessionId) && !selected.some((item) => item.member.sessionId === candidate.sessionId));
    if (member) {
      selected.push({ task, member });
      if (selected.length >= room.coordination.maxConcurrency - busyMembers.size) break;
    } else {
      result.skipped.push({ taskId: task.id, reason: "No available room member." });
    }
  }
  const settled = await Promise.allSettled(selected.map(({ task, member }) => dispatchTask(roomId, task, member)));
  settled.forEach((outcome, index) => {
    const { task, member } = selected[index];
    if (outcome.status === "fulfilled") result.dispatched.push({ taskId: task.id, sessionId: member.sessionId, ...outcome.value });
    else {
      const error = outcome.reason as SessionMessageRouterError;
      result.skipped.push({ taskId: task.id, reason: error instanceof Error ? error.message : String(error), ...(error?.code ? { code: error.code } : {}) });
    }
  });
  return result;
}
