"use client";
import { brandText } from "@/lib/branding";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getRoomMemberName, getRoomMemberSessionId, type CollaborationRoom } from "@/lib/room-types";
import type { SessionInfo } from "@/lib/types";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { AliIcon } from "./AliIcon";
import styles from "./RoomSidebarSection.module.css";

type RoomsResponse = { rooms?: CollaborationRoom[]; room?: CollaborationRoom; error?: string };

function sessionLabel(session: SessionInfo): string {
  return session.name?.trim() || session.firstMessage?.trim().slice(0, 56) || session.id.slice(0, 8);
}

function sessionProject(session: SessionInfo): string {
  return session.projectRoot ?? session.cwd;
}

export function RoomSidebarSection({
  sessions,
  selectedSessionId,
  selectedRoomId,
  initialRoomId,
  refreshKey,
  onSelectRoom,
  onInitialRestoreDone,
}: {
  sessions: SessionInfo[];
  selectedSessionId: string | null;
  selectedRoomId: string | null;
  activeProjectRoot?: string | null;
  initialRoomId?: string | null;
  refreshKey?: number;
  onSelectRoom: (room: CollaborationRoom, isRestore?: boolean) => void;
  onInitialRestoreDone?: () => void;
}) {
  const [rooms, setRooms] = useState<CollaborationRoom[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restoredRef = useRef(false);
  const dialogRef = useRef<HTMLElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useFocusTrap(dialogRef, createOpen, {
    initialFocus: nameInputRef,
    onEscape: busy ? undefined : () => setCreateOpen(false),
  });

  const loadRooms = useCallback(async () => {
    const response = await fetch("/api/rooms", { cache: "no-store" });
    const data = await response.json() as RoomsResponse;
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    setRooms(data.rooms ?? []);
    setLoaded(true);
    return data.rooms ?? [];
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => void loadRooms().catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loadRooms, refreshKey]);

  useEffect(() => {
    if (restoredRef.current || !initialRoomId) return;
    const target = rooms.find((room) => room.id === initialRoomId);
    if (target) {
      restoredRef.current = true;
      onSelectRoom(target, true);
      onInitialRestoreDone?.();
      return;
    }
    if (loaded) {
      restoredRef.current = true;
      onInitialRestoreDone?.();
    }
  }, [initialRoomId, loaded, onInitialRestoreDone, onSelectRoom, rooms]);

  const groupedSessions = useMemo(() => {
    const result = new Map<string, SessionInfo[]>();
    for (const session of sessions) {
      const root = sessionProject(session);
      const current = result.get(root) ?? [];
      current.push(session);
      result.set(root, current);
    }
    return [...result.entries()];
  }, [sessions]);

  const openCreate = () => {
    const currentRoom = rooms.find((room) => room.id === selectedRoomId);
    const fallbackMember = currentRoom?.members.find((member) => member.memberId === currentRoom.coordination.coordinatorMemberId)
      ?? currentRoom?.members[0];
    const selectedSession = sessions.find((session) => session.id === selectedSessionId)
      ?? sessions.find((session) => session.id === (fallbackMember ? getRoomMemberSessionId(fallbackMember) : undefined))
      ?? sessions[0];
    const creatorId = selectedSession?.id ?? (fallbackMember ? getRoomMemberSessionId(fallbackMember) : undefined);
    setSelectedIds(new Set(creatorId ? [creatorId] : []));
    setName("");
    setDescription("");
    setError(null);
    setCreateOpen(true);
  };

  const toggleSession = (sessionId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const createRoom = async () => {
    const selected = sessions.filter((session) => selectedIds.has(session.id));
    const currentRoom = rooms.find((room) => room.id === selectedRoomId);
    const fallbackMember = currentRoom?.members.find((member) => member.memberId === currentRoom.coordination.coordinatorMemberId)
      ?? currentRoom?.members[0];
    const preferredCreator = selected.find((session) => session.id === selectedSessionId) ?? selected[0];
    const creator = preferredCreator ? {
      sessionId: preferredCreator.id,
      sessionName: sessionLabel(preferredCreator),
      cwd: preferredCreator.cwd,
      projectRoot: sessionProject(preferredCreator),
    } : fallbackMember ? {
      sessionId: getRoomMemberSessionId(fallbackMember),
      sessionName: getRoomMemberName(fallbackMember),
      cwd: fallbackMember.binding.cwd ?? currentRoom?.projectRoot,
      projectRoot: fallbackMember.binding.projectRoot ?? currentRoom?.projectRoot,
    } : null;
    if (!name.trim() || !creator?.cwd) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          sessionId: creator.sessionId,
          sessionName: creator.sessionName,
          cwd: creator.cwd,
          projectRoot: creator.projectRoot,
          members: selected.filter((session) => session.id !== creator.sessionId).map((session) => ({
            sessionId: session.id,
            sessionName: sessionLabel(session),
            cwd: session.cwd,
            projectRoot: sessionProject(session),
            role: "participant",
          })),
        }),
      });
      const data = await response.json() as RoomsResponse;
      if (!response.ok || !data.room) throw new Error(data.error ?? `HTTP ${response.status}`);
      const nextRooms = await loadRooms();
      const created = nextRooms.find((room) => room.id === data.room?.id) ?? data.room;
      setCreateOpen(false);
      onSelectRoom(created);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.section} aria-label="群聊">
      <div className={styles.heading}>
        <span>群聊</span>
        <button type="button" className={styles.addButton} onClick={openCreate} aria-label="新建群聊" title="新建群聊">
          <AliIcon name="plus" size={13} />
        </button>
      </div>
      <div className={styles.list}>
        {rooms.length === 0 ? <div className={styles.empty}>创建一个多会话群聊</div> : rooms.map((room) => (
          <button
            key={room.id}
            type="button"
            className={`${styles.roomRow}${room.id === selectedRoomId ? ` ${styles.selected}` : ""}`}
            onClick={() => onSelectRoom(room)}
          >
              <span className={styles.roomIcon} aria-hidden="true"><AliIcon name="messages" size={14} /></span>
            <span className={styles.roomCopy}>
              <strong>{room.name}</strong>
              <small>{room.members.length} 个智能体 · {room.workspace.label}</small>
            </span>
          </button>
        ))}
      </div>
      {createOpen ? (
        <div className={styles.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setCreateOpen(false); }}>
          <section ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="room-create-title">
            <div className={styles.dialogHeader}>
              <div>
                <h2 id="room-create-title">新建群聊</h2>
                <p>只需填写名称即可创建；其他成员和说明都可以稍后设置。</p>
              </div>
              <button type="button" className={styles.closeButton} onClick={() => setCreateOpen(false)} aria-label="关闭" disabled={busy}>
                <AliIcon name="close" size={15} />
              </button>
            </div>
            <div className={styles.dialogBody}>
              <label className={styles.field}>
                <span>群名称</span>
                <input ref={nameInputRef} value={name} onChange={(event) => setName(event.target.value)} placeholder={brandText("例如：Piora 重构讨论组")} maxLength={120} />
              </label>
              <details className={styles.advancedCreate}>
                <summary>更多设置（可选）<small>当前 {selectedIds.size} 个智能体</small></summary>
                <label className={styles.field}>
                  <span>团队说明</span>
                  <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="团队要完成什么，以及最终交付标准" rows={3} maxLength={2_000} />
                </label>
                <div className={styles.memberHeader}>
                  <span>初始智能体</span>
                  <small>已选择 {selectedIds.size} 个会话</small>
                </div>
                <div className={styles.members}>
                  {groupedSessions.map(([root, projectSessions]) => (
                    <section key={root} className={styles.projectGroup}>
                      <div className={styles.projectHeading}><AliIcon name="folder" size={13} /><span>{root}</span></div>
                      {projectSessions.map((session) => (
                        <label key={session.id} className={styles.memberRow}>
                          <input type="checkbox" checked={selectedIds.has(session.id)} onChange={() => toggleSession(session.id)} />
                          <span className={styles.avatar}>{sessionLabel(session).slice(0, 1).toLocaleUpperCase()}</span>
                          <span className={styles.memberCopy}>
                            <strong>{sessionLabel(session)}</strong>
                            <small>{session.worktreeBranch ?? session.cwd}</small>
                          </span>
                        </label>
                      ))}
                    </section>
                  ))}
                </div>
              </details>
              {error ? <p className={styles.error} role="alert">{error}</p> : null}
            </div>
            <div className={styles.dialogActions}>
              <button type="button" onClick={() => setCreateOpen(false)} disabled={busy}>取消</button>
              <button type="button" className={styles.primary} onClick={() => { void createRoom(); }} disabled={busy || !name.trim() || selectedIds.size === 0}>
                {busy ? "创建中…" : "创建群聊"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {error && !createOpen ? <div className={styles.inlineError}>{error}</div> : null}
    </section>
  );
}
