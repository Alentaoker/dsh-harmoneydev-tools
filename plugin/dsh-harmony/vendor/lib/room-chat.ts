import { getRpcSession } from "./rpc-manager";
import { appendRoomMessage, emitRoomPresence, getRoom, listRoomMessages } from "./room-store";
import { resolveExplicitRoomChatTargets } from "./room-chat-routing";
import {
  getSessionMessageRouter,
  type SessionMessageRouter,
  type SessionMessageRouterError,
} from "./session-message-router";
import type { SessionCommandEvent, SessionCommandStatus } from "./session-message-types";
import { getRoomMemberName, type CollaborationRoom, type RoomMember, type RoomMessage } from "./room-types";

const DEFAULT_ROOM_AUTO_ROUNDS = 6;
const MAX_ROOM_AUTO_ROUNDS = 8;

export interface RoomChatDispatchResult {
  dispatched: Array<{ sessionId: string; behavior: "prompt" | "next_turn"; commandId: string; status: string }>;
  skipped: Array<{ sessionId: string; reason: string; code?: string }>;
}

function groupChatPrompt(room: CollaborationRoom, member: RoomMember, input: { messageId: string; content: string; authorName?: string; authorSessionId?: string; replyTo?: string; correlationId?: string; forwardDepth?: number; autoRound?: number; maxAutoRounds?: number }): string {
  const coordinator = room.members.find((candidate) => candidate.memberId === room.coordination.coordinatorMemberId);
  const coordinatorName = coordinator ? getRoomMemberName(coordinator) : "协调者";
  const isCoordinator = member.memberId === room.coordination.coordinatorMemberId;
  return [
    "[PIORA GROUP CHAT]",
    `Room: ${room.name} (${room.id})`,
    `Message ID: ${input.messageId}`,
    `Correlation ID: ${input.correlationId || input.messageId}`,
    `Reply to: ${input.replyTo || "(root message)"}`,
    `Automatic response round: ${input.autoRound ?? 0}/${input.maxAutoRounds ?? 1}`,
    `Shared message from: ${input.authorName || input.authorSessionId || "User"}`,
    `Your team identity: ${member.name || member.sessionId} (${member.role})`,
    `Your responsibility: ${member.instructions || "Collaborate according to your assigned role."}`,
    `Shared workspace: ${room.workspace.path}`,
    `Workspace contract: ${room.workspace.instructions || "Publish reusable work and avoid overwriting another Agent's active changes."}`,
    `Shared message: ${input.content}`,
    "You were addressed in a Piora group conversation.",
    "Respond to the group, not only to your private session: use the piora_room tool with action send_shared, this exact room ID, and replyTo set to the Message ID above.",
    "Keep the shared reply concise, include replyTo/correlation context when replying, and do not repeat a reply for the same message ID.",
    "Do not automatically rebroadcast another Agent's shared reply; only respond when explicitly mentioned or routed by the Coordinator.",
    ...(isCoordinator ? [
      "You are the runtime scheduler for this group. Decide which Agent should act next and do not wake a dependent Agent before its prerequisite result arrives.",
      "To actually invoke an Agent, send a separate shared message beginning with that Agent's exact @name. Merely describing who should work does not dispatch anything.",
      "Each delegation message must contain exactly one @name anywhere in its content. Send another message for another Agent; refer to prerequisites without typing their @name.",
      "For implementation followed by review: @mention the implementer first, wait for their @completion report, inspect that report, and only then @mention the reviewer.",
    ] : [
      `Complete only the work requested in this message. When finished, send a concise shared completion report beginning with @${coordinatorName} so the scheduler is actually invoked for the next step.`,
      `If a prerequisite is missing, do not pretend to wait in this turn; report the blocker to @${coordinatorName} and stop.`,
    ]),
  ].join("\n");
}

export function deriveRoomReplyRoutingMetadata(roomId: string, replyTo?: string): Pick<RoomMessage, "forwardDepth" | "autoRound" | "maxAutoRounds"> {
  const parent = replyTo ? listRoomMessages(roomId, { limit: 500 }).find((message) => message.id === replyTo) : undefined;
  return {
    forwardDepth: Math.min(MAX_ROOM_AUTO_ROUNDS, (parent?.forwardDepth ?? -1) + 1),
    autoRound: Math.min(MAX_ROOM_AUTO_ROUNDS, (parent?.autoRound ?? -1) + 1),
    maxAutoRounds: parent?.maxAutoRounds ?? DEFAULT_ROOM_AUTO_ROUNDS,
  };
}

function isTerminalStatus(status: SessionCommandStatus): boolean {
  return ["completed", "failed", "cancelled", "expired", "interrupted"].includes(status);
}

function relayRoomReply(
  router: SessionMessageRouter,
  room: CollaborationRoom,
  member: RoomMember,
  messageId: string,
  commandId: string,
  initialStatus: SessionCommandStatus,
): void {
  const startedAt = Date.now();
  let settled = false;
  let unsubscribe = () => {};

  const finish = (status: "completed" | "error", detail?: string) => {
    if (settled) return;
    settled = true;
    unsubscribe();
    if (status === "completed") {
      const alreadyShared = listRoomMessages(room.id).some((message) => (
        message.author.id === member.sessionId
        && (message.replyTo === messageId || message.createdAt >= startedAt)
      ));
      if (!alreadyShared) {
        const content = getRpcSession(member.sessionId)?.inner.getLastAssistantText()?.trim();
        if (content) {
          const reply = appendRoomMessage(room.id, {
            authorKind: "session",
            authorId: member.sessionId,
            authorName: member.name,
            content,
            replyTo: messageId,
            ...deriveRoomReplyRoutingMetadata(room.id, messageId),
          });
          void dispatchExplicitRoomMentions(room.id, reply, router).catch((error) => {
            emitRoomPresence(room.id, {
              sessionId: member.sessionId,
              messageId: reply.id,
              status: "error",
              detail: error instanceof Error ? error.message : String(error),
            });
          });
        }
      }
    }
    emitRoomPresence(room.id, { sessionId: member.sessionId, messageId, status, detail });
  };

  const handleEvent = (event: SessionCommandEvent) => {
    if (event.commandId !== commandId) return;
    if (event.type === "command_completed") finish("completed");
    else if (["command_failed", "command_cancelled", "command_expired", "command_interrupted"].includes(event.type)) {
      finish("error", event.errorMessage || "Agent 处理失败");
    }
  };

  unsubscribe = router.subscribeEvents(member.sessionId, handleEvent);
  if (initialStatus === "completed") finish("completed");
  else if (isTerminalStatus(initialStatus)) finish("error", "Agent 处理失败");
  else {
    void router.getCommand(commandId).then((command) => {
      if (command.status === "completed") finish("completed");
      else if (isTerminalStatus(command.status)) finish("error", command.errorMessage || "Agent 处理失败");
    }).catch(() => {
      // The event subscription remains authoritative if the status snapshot races persistence.
    });
  }
}

export async function dispatchRoomChat(
  roomId: string,
  input: { messageId: string; content: string; authorName?: string; authorSessionId?: string; targetSessionIds?: string[]; attempt?: number; replyTo?: string; correlationId?: string; forwardDepth?: number; autoRound?: number; maxAutoRounds?: number; router?: SessionMessageRouter },
): Promise<RoomChatDispatchResult> {
  const room = getRoom(roomId);
  const requested = new Set(input.targetSessionIds?.filter(Boolean));
  const fallbackId = room.coordination.coordinatorSessionId ?? room.members[0]?.sessionId;
  if (requested.size === 0 && fallbackId) requested.add(fallbackId);

  const result: RoomChatDispatchResult = { dispatched: [], skipped: [] };
  const forwardDepth = Math.max(0, Math.floor(input.forwardDepth ?? 0));
  const autoRound = Math.max(0, Math.floor(input.autoRound ?? 0));
  const maxAutoRounds = Math.max(0, Math.min(MAX_ROOM_AUTO_ROUNDS, Math.floor(input.maxAutoRounds ?? DEFAULT_ROOM_AUTO_ROUNDS)));
  if (forwardDepth > MAX_ROOM_AUTO_ROUNDS || autoRound > maxAutoRounds) {
    result.skipped.push({ sessionId: "*", reason: "Room automatic routing limit reached.", code: "ROOM_ROUTING_LIMIT" });
    return result;
  }
  const router = input.router ?? getSessionMessageRouter();
  const targets = [...requested].flatMap((sessionId) => {
    const member = room.members.find((item) => item.sessionId === sessionId);
    return member ? [{ sessionId, member }] : (result.skipped.push({ sessionId, reason: "Session is not a room member." }), []);
  });
  const maxConcurrency = Math.max(1, Math.min(16, room.coordination.maxConcurrency));
  // The legacy `{ type: behavior }` command shape is normalized by the Router;
  // new Room deliveries are always queued as next_turn commands.
  const behavior = "next_turn" as const;
  for (let index = 0; index < targets.length; index += maxConcurrency) {
    const batch = targets.slice(index, index + maxConcurrency);
    batch.forEach(({ sessionId }) => {
      emitRoomPresence(room.id, { sessionId, messageId: input.messageId, status: "processing" });
    });
    const settled = await Promise.allSettled(batch.map(({ sessionId, member }) => router.dispatchSessionMessage({
      targetSessionId: sessionId,
      content: groupChatPrompt(room, member, input),
      delivery: behavior,
      source: "room",
      roomContext: { roomId, messageId: input.messageId },
      idempotencyKey: `${roomId}:${input.messageId}:${sessionId}:${input.attempt ?? 1}`,
    })));
    settled.forEach((outcome, batchIndex) => {
      const target = batch[batchIndex];
      if (outcome.status === "fulfilled") {
        result.dispatched.push({ sessionId: target.sessionId, behavior, commandId: outcome.value.commandId, status: outcome.value.status });
        relayRoomReply(router, room, target.member, input.messageId, outcome.value.commandId, outcome.value.status);
      } else {
        const error = outcome.reason as SessionMessageRouterError;
        const reason = error instanceof Error ? error.message : String(error);
        emitRoomPresence(room.id, { sessionId: target.sessionId, messageId: input.messageId, status: "error", detail: reason });
        result.skipped.push({ sessionId: target.sessionId, reason, ...(error?.code ? { code: error.code } : {}) });
      }
    });
  }
  return result;
}

export async function dispatchExplicitRoomMentions(
  roomId: string,
  message: RoomMessage,
  router: SessionMessageRouter = getSessionMessageRouter(),
): Promise<RoomChatDispatchResult> {
  const room = getRoom(roomId);
  const explicitlyMentioned = resolveExplicitRoomChatTargets(room, message.content, {
    excludeSessionId: message.author.kind === "session" ? message.author.id : undefined,
  });
  if (explicitlyMentioned.length === 0) return { dispatched: [], skipped: [] };
  const coordinator = room.members.find((member) => member.memberId === room.coordination.coordinatorMemberId);
  const coordinatorSessionId = coordinator?.binding.sessionId;
  const isCoordinatorMessage = message.author.kind === "session" && message.author.id === coordinatorSessionId;
  let targetSessionIds = explicitlyMentioned;
  const schedulerSkips: RoomChatDispatchResult["skipped"] = [];
  if (room.coordination.mode === "team" && message.author.kind === "session") {
    if (isCoordinatorMessage && explicitlyMentioned.length > 1) {
      targetSessionIds = [];
      schedulerSkips.push(...explicitlyMentioned.map((sessionId) => ({
        sessionId,
        reason: "协调者必须用每条只包含一名成员的 @消息逐个派工，当前消息未唤起任何成员。",
        code: "ROOM_COORDINATOR_ONE_TARGET",
      })));
    } else if (!isCoordinatorMessage && coordinatorSessionId) {
      targetSessionIds = [coordinatorSessionId];
      schedulerSkips.push(...explicitlyMentioned.filter((sessionId) => sessionId !== coordinatorSessionId).map((sessionId) => ({
        sessionId,
        reason: "团队成员的完成或协作消息先回报协调者，由协调者决定下一位智能体的启动时机。",
        code: "ROOM_COORDINATOR_SCHEDULED",
      })));
    }
  }
  if (targetSessionIds.length === 0) return { dispatched: [], skipped: schedulerSkips };
  const routed = await dispatchRoomChat(roomId, {
    messageId: message.id,
    content: message.content,
    authorName: message.author.name,
    authorSessionId: message.author.id,
    targetSessionIds,
    replyTo: message.replyTo,
    correlationId: message.correlationId ?? message.id,
    forwardDepth: message.forwardDepth,
    autoRound: message.autoRound,
    maxAutoRounds: message.maxAutoRounds,
    router,
  });
  return { dispatched: routed.dispatched, skipped: [...schedulerSkips, ...routed.skipped] };
}
