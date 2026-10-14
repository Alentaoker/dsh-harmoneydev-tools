import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { getRoomsRoot } from "./room-store";
import { TeamError } from "./team-errors";
import { isTerminalTeamRun, reduceTeamRunEvent, replayTeamRunEvents } from "./team-run-reducer";
import {
  TEAM_DEFAULTS,
  type AppendTeamEventInput,
  type TeamOutboxRecord,
  type TeamRunActor,
  type TeamRunEvent,
  type TeamRunEventEnvelope,
  type TeamRunSnapshot,
  type TeamRunState,
} from "./team-types";

const ID_PATTERN = /^[0-9a-f-]{36}$/i;

type TeamRunListener = (event: TeamRunEventEnvelope) => void;

declare global {
  var __pioraTeamRunStore: TeamRunStore | undefined;
  var __pioraTeamRunListeners: Map<string, Set<TeamRunListener>> | undefined;
}

function listeners(): Map<string, Set<TeamRunListener>> {
  return globalThis.__pioraTeamRunListeners ??= new Map();
}

function assertId(value: string, label: string): string {
  if (!ID_PATTERN.test(value)) throw new TeamError("TEAM_INVALID_INPUT", `Invalid ${label}.`);
  return value;
}

function writeDurableLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const descriptor = openSync(path, "a", 0o600);
  try {
    appendFileSync(descriptor, `${line}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
}

function checksumSnapshot(snapshot: Omit<TeamRunSnapshot, "checksum">): string {
  return createHash("sha256").update(JSON.stringify(snapshot), "utf8").digest("hex");
}

function maxSerializedEventBytes(event: TeamRunEvent): number {
  if (event.type === "run.created") return TEAM_DEFAULTS.maxInputBytes + 8 * 1024;
  // A structured plan contains the bounded definitions for as many as 64
  // tasks. It remains bounded as one atomic reducer transition.
  if (event.type === "plan.submitted") return 8 * 1024 * 1024;
  return TEAM_DEFAULTS.maxEventBytes;
}

function snapshotWithoutChecksum(snapshot: TeamRunSnapshot): Omit<TeamRunSnapshot, "checksum"> {
  const { checksum, ...value } = snapshot;
  void checksum;
  return value;
}

function parseJournal<T>(path: string, repairTrailing: boolean): T[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  const output: T[] = [];
  let byteOffset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.replace(/\r$/, "");
    const lineBytes = Buffer.byteLength(lines[index]!, "utf8") + (index < lines.length - 1 ? 1 : 0);
    if (!line) {
      byteOffset += lineBytes;
      continue;
    }
    try {
      output.push(JSON.parse(line) as T);
    } catch {
      const isTrailing = index === lines.length - 1 || lines.slice(index + 1).every((candidate) => !candidate.trim());
      if (isTrailing && repairTrailing) {
        truncateSync(path, byteOffset);
        break;
      }
      throw new TeamError("TEAM_EVENT_LOG_CORRUPT", "TeamRun journal contains invalid JSON before its tail.", { line: index + 1 });
    }
    byteOffset += lineBytes;
  }
  return output;
}

export interface CreateTeamRunInput {
  roomId: string;
  objective: string;
  coordinatorMemberId: string;
  createdBy: { kind: "user" | "member"; id: string };
  teamRunId?: string;
  at?: number;
  correlationId?: string;
}

export interface TeamRunStoreOptions {
  roomsRoot?: string;
  now?: () => number;
  uuid?: () => string;
}

export class TeamRunStore {
  readonly roomsRoot: string;
  private readonly now: () => number;
  private readonly uuid: () => string;

  constructor(options: TeamRunStoreOptions = {}) {
    this.roomsRoot = resolve(options.roomsRoot ?? process.env.PIORA_ROOMS_ROOT ?? getRoomsRoot());
    this.now = options.now ?? Date.now;
    this.uuid = options.uuid ?? randomUUID;
  }

  roomRoot(roomId: string): string {
    return join(this.roomsRoot, assertId(roomId, "room id"));
  }

  runsRoot(roomId: string): string {
    return join(this.roomRoot(roomId), "shared", "runs");
  }

  runDirectory(roomId: string, teamRunId: string): string {
    return join(this.runsRoot(roomId), assertId(teamRunId, "TeamRun id"));
  }

  paths(roomId: string, teamRunId: string) {
    const root = this.runDirectory(roomId, teamRunId);
    return {
      root,
      events: join(root, "events.jsonl"),
      snapshot: join(root, "snapshot.json"),
      outbox: join(root, "outbox.jsonl"),
      secrets: join(root, "outbox-secrets.json"),
    };
  }

  private async withLock<T>(roomId: string, teamRunId: string, operation: () => T | Promise<T>): Promise<T> {
    const root = this.runDirectory(roomId, teamRunId);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(root, {
      realpath: false,
      retries: { retries: 100, factor: 1.1, minTimeout: 2, maxTimeout: 50 },
      stale: 30_000,
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  private readEvents(roomId: string, teamRunId: string, repairTrailing = false): TeamRunEventEnvelope[] {
    const events = parseJournal<TeamRunEventEnvelope>(this.paths(roomId, teamRunId).events, repairTrailing);
    if (events.length > TEAM_DEFAULTS.maxEvents) throw new TeamError("TEAM_CAPACITY_EXCEEDED", "TeamRun event limit exceeded.");
    for (const event of events) {
      if (event.roomId !== roomId || event.teamRunId !== teamRunId) {
        throw new TeamError("TEAM_EVENT_LOG_CORRUPT", "TeamRun journal contains a foreign event identity.");
      }
    }
    return events;
  }

  private readState(roomId: string, teamRunId: string, repairTrailing = false): TeamRunState {
    const events = this.readEvents(roomId, teamRunId, repairTrailing);
    if (events.length === 0) throw new TeamError("TEAM_RUN_NOT_FOUND", "TeamRun was not found.");
    return this.readValidSnapshot(roomId, teamRunId, events.at(-1)!) ?? replayTeamRunEvents(events);
  }

  private writeSnapshot(roomId: string, teamRunId: string, state: TeamRunState, lastEvent: TeamRunEventEnvelope): void {
    const path = this.paths(roomId, teamRunId).snapshot;
    const content: Omit<TeamRunSnapshot, "checksum"> = {
      schemaVersion: 1,
      revision: state.revision,
      lastEventId: lastEvent.id,
      lastCursor: lastEvent.cursor,
      state,
    };
    const snapshot: TeamRunSnapshot = { ...content, checksum: checksumSnapshot(content) };
    const temporary = `${path}.${process.pid}.${this.uuid()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", mode: 0o600, flush: true });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  }

  private readValidSnapshot(roomId: string, teamRunId: string, lastEvent: TeamRunEventEnvelope): TeamRunState | undefined {
    const path = this.paths(roomId, teamRunId).snapshot;
    if (!existsSync(path)) return undefined;
    try {
      const snapshot = JSON.parse(readFileSync(path, "utf8")) as TeamRunSnapshot;
      const valid = snapshot.schemaVersion === 1
        && snapshot.lastCursor === lastEvent.cursor
        && snapshot.lastEventId === lastEvent.id
        && snapshot.state.id === teamRunId
        && snapshot.state.roomId === roomId
        && snapshot.state.revision === snapshot.revision
        && snapshot.checksum === checksumSnapshot(snapshotWithoutChecksum(snapshot));
      return valid ? snapshot.state : undefined;
    } catch {
      return undefined;
    }
  }

  async createTeamRun(input: CreateTeamRunInput): Promise<TeamRunState> {
    const roomId = assertId(input.roomId, "room id");
    const teamRunId = assertId(input.teamRunId ?? this.uuid(), "TeamRun id");
    const at = input.at ?? this.now();
    const actor: TeamRunActor = input.createdBy.kind === "member"
      ? { kind: "member", memberId: input.createdBy.id }
      : { kind: "user", id: input.createdBy.id };
    let broadcast: TeamRunEventEnvelope | undefined;
    const state = await this.withLock(roomId, teamRunId, () => {
      const paths = this.paths(roomId, teamRunId);
      if (existsSync(paths.events) && readFileSync(paths.events, "utf8").trim()) {
        throw new TeamError("TEAM_REVISION_CONFLICT", "TeamRun already exists.");
      }
      const envelope: TeamRunEventEnvelope = {
        schemaVersion: 1,
        id: this.uuid(),
        cursor: 1,
        roomId,
        teamRunId,
        at,
        actor,
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        event: {
          type: "run.created",
          objective: input.objective,
          coordinatorMemberId: input.coordinatorMemberId,
          createdBy: input.createdBy,
        },
      };
      const projection = replayTeamRunEvents([envelope]);
      const serialized = JSON.stringify(envelope);
      if (Buffer.byteLength(serialized, "utf8") > maxSerializedEventBytes(envelope.event)) throw new TeamError("TEAM_INPUT_TOO_LARGE", "TeamRun creation event is too large.");
      writeDurableLine(paths.events, serialized);
      this.writeSnapshot(roomId, teamRunId, projection, envelope);
      broadcast = envelope;
      return projection;
    });
    if (broadcast) this.broadcast(broadcast);
    return state;
  }

  getTeamRun(roomId: string, teamRunId: string): TeamRunState {
    const events = this.readEvents(roomId, teamRunId, true);
    if (events.length === 0) throw new TeamError("TEAM_RUN_NOT_FOUND", "TeamRun was not found.");
    const last = events.at(-1)!;
    const snapshotState = this.readValidSnapshot(roomId, teamRunId, last);
    if (snapshotState) return snapshotState;
    const state = replayTeamRunEvents(events);
    this.writeSnapshot(roomId, teamRunId, state, last);
    return state;
  }

  listTeamRuns(roomId: string, options: { limit?: number; includeTerminal?: boolean } = {}): TeamRunState[] {
    const root = this.runsRoot(assertId(roomId, "room id"));
    if (!existsSync(root)) return [];
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 50)));
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) return [];
      try {
        const state = this.getTeamRun(roomId, entry.name);
        return options.includeTerminal === false && isTerminalTeamRun(state) ? [] : [state];
      } catch {
        return [];
      }
    }).sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit);
  }

  listRoomIds(): string[] {
    if (!existsSync(this.roomsRoot)) return [];
    return readdirSync(this.roomsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name))
      .map((entry) => entry.name);
  }

  findTeamRunByCorrelationId(roomId: string, correlationId: string): TeamRunState | undefined {
    if (!correlationId.trim()) return undefined;
    const runsRoot = this.runsRoot(assertId(roomId, "room id"));
    if (!existsSync(runsRoot)) return undefined;
    for (const entry of readdirSync(runsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
      const first = this.readEvents(roomId, entry.name, true)[0];
      if (first?.correlationId === correlationId) return this.getTeamRun(roomId, entry.name);
    }
    return undefined;
  }

  async migrateLegacyRoomTasks(roomId: string, coordinatorMemberId: string): Promise<TeamRunState[]> {
    const legacyRoot = join(this.roomRoot(roomId), "shared", "legacy-tasks");
    if (!existsSync(legacyRoot)) return [];
    const migrated: TeamRunState[] = [];
    for (const entry of readdirSync(legacyRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      let raw: Record<string, unknown>;
      try { raw = JSON.parse(readFileSync(join(legacyRoot, entry.name), "utf8")) as Record<string, unknown>; }
      catch { continue; }
      if (["completed", "failed", "cancelled"].includes(String(raw.status))) continue;
      const digest = createHash("sha256").update(`${roomId}:${String(raw.id ?? entry.name)}`, "utf8").digest("hex");
      const runId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
      try {
        migrated.push(this.getTeamRun(roomId, runId));
        continue;
      } catch (error) {
        if (error instanceof TeamError && error.code !== "TEAM_RUN_NOT_FOUND") throw error;
      }
      const at = typeof raw.updatedAt === "number" ? raw.updatedAt : this.now();
      let state = await this.createTeamRun({
        roomId,
        teamRunId: runId,
        objective: typeof raw.title === "string" && raw.title.trim() ? raw.title : "Legacy Room task",
        coordinatorMemberId,
        createdBy: { kind: "user", id: typeof raw.createdBy === "string" ? raw.createdBy : "legacy-migration" },
        at,
        correlationId: `legacy-task:${String(raw.id ?? entry.name)}`,
      });
      const taskId = `${runId}:legacy`;
      state = await this.appendTeamRunEvents(roomId, runId, state.revision, [
        {
          at,
          event: {
            type: "task.created",
            task: {
              schemaVersion: 1,
              id: taskId,
              teamRunId: runId,
              title: typeof raw.title === "string" && raw.title.trim() ? raw.title : "Legacy Room task",
              description: typeof raw.description === "string" && raw.description.trim() ? raw.description : "Migrated from the Room v2 task store.",
              acceptanceCriteria: ["User explicitly resumes or cancels this migrated task."],
              requiredCapabilities: [],
              dependsOn: [],
              priority: typeof raw.priority === "number" ? raw.priority : 0,
              status: "pending",
              assignmentMode: "auto",
              attempt: typeof raw.attempt === "number" ? raw.attempt : 0,
              maxAttempts: typeof raw.maxAttempts === "number" && raw.maxAttempts > 0 ? raw.maxAttempts : TEAM_DEFAULTS.maxTaskAttempts,
              reviewPolicy: { required: false, reviewerMemberIds: [], minimumApprovals: 0 },
              reviewRound: 0,
              createdAt: typeof raw.createdAt === "number" ? raw.createdAt : at,
              updatedAt: at,
            },
          },
        },
        { at, event: { type: "run.interrupted", reason: "Migrated from a non-terminal Room v2 task. It will not run until the user explicitly resumes it." } },
      ]);
      migrated.push(state);
    }
    return migrated;
  }

  async appendTeamRunEvents(
    roomId: string,
    teamRunId: string,
    expectedRevision: number,
    inputs: readonly (AppendTeamEventInput | TeamRunEvent)[],
  ): Promise<TeamRunState> {
    if (inputs.length === 0) return this.getTeamRun(roomId, teamRunId);
    const emitted: TeamRunEventEnvelope[] = [];
    const state = await this.withLock(roomId, teamRunId, () => {
      const previousEvents = this.readEvents(roomId, teamRunId, true);
      if (previousEvents.length === 0) throw new TeamError("TEAM_RUN_NOT_FOUND", "TeamRun was not found.");
      let projection = this.readValidSnapshot(roomId, teamRunId, previousEvents.at(-1)!) ?? replayTeamRunEvents(previousEvents);
      if (projection.revision !== expectedRevision) {
        throw new TeamError("TEAM_REVISION_CONFLICT", "TeamRun revision changed before the mutation was committed.", {
          expectedRevision,
          actualRevision: projection.revision,
        });
      }
      if (previousEvents.length + inputs.length > TEAM_DEFAULTS.maxEvents) throw new TeamError("TEAM_CAPACITY_EXCEEDED", "TeamRun event limit reached.");
      const lines: string[] = [];
      for (const raw of inputs) {
        const input: AppendTeamEventInput = "event" in raw ? raw : { event: raw };
        const envelope: TeamRunEventEnvelope = {
          schemaVersion: 1,
          id: input.id ?? this.uuid(),
          cursor: projection.revision + 1,
          roomId,
          teamRunId,
          at: input.at ?? this.now(),
          actor: input.actor ?? { kind: "system", id: "piora" },
          ...(input.causationId ? { causationId: input.causationId } : {}),
          ...(input.correlationId ? { correlationId: input.correlationId } : {}),
          event: input.event,
        };
        projection = reduceTeamRunEvent(projection, envelope);
        const serialized = JSON.stringify(envelope);
        if (Buffer.byteLength(serialized, "utf8") > maxSerializedEventBytes(envelope.event)) throw new TeamError("TEAM_INPUT_TOO_LARGE", "TeamRun event exceeds its bounded size limit.");
        lines.push(serialized);
        emitted.push(envelope);
      }
      const path = this.paths(roomId, teamRunId).events;
      const descriptor = openSync(path, "a", 0o600);
      try {
        appendFileSync(descriptor, `${lines.join("\n")}\n`, "utf8");
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      this.writeSnapshot(roomId, teamRunId, projection, emitted.at(-1)!);
      return projection;
    });
    for (const event of emitted) this.broadcast(event);
    return state;
  }

  listTeamRunEvents(roomId: string, teamRunId: string, afterCursor = 0): TeamRunEventEnvelope[] {
    return this.readEvents(roomId, teamRunId, false).filter((event) => event.cursor > Math.max(0, afterCursor));
  }

  listTeamOutbox(roomId: string, teamRunId: string, options: { pendingOnly?: boolean } = {}): TeamOutboxRecord[] {
    const entries = parseJournal<TeamOutboxRecord>(this.paths(roomId, teamRunId).outbox, true);
    const latest = new Map<string, TeamOutboxRecord>();
    for (const entry of entries) latest.set(entry.id, entry);
    const records = [...latest.values()].sort((left, right) => left.createdAt - right.createdAt);
    return options.pendingOnly ? records.filter((record) => record.status === "pending") : records;
  }

  async appendTeamOutbox(
    roomId: string,
    teamRunId: string,
    input: Omit<TeamOutboxRecord, "schemaVersion" | "id" | "roomId" | "teamRunId" | "status" | "attempts" | "createdAt" | "updatedAt"> & { id?: string },
  ): Promise<TeamOutboxRecord> {
    return this.withLock(roomId, teamRunId, () => {
      this.readState(roomId, teamRunId, true);
      const existing = this.listTeamOutbox(roomId, teamRunId).find((record) => record.idempotencyKey === input.idempotencyKey);
      if (existing) return existing;
      const now = this.now();
      const record: TeamOutboxRecord = {
        schemaVersion: 1,
        id: input.id ?? this.uuid(),
        roomId,
        teamRunId,
        kind: input.kind,
        idempotencyKey: input.idempotencyKey,
        payload: structuredClone(input.payload),
        status: "pending",
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      };
      writeDurableLine(this.paths(roomId, teamRunId).outbox, JSON.stringify(record));
      return record;
    });
  }

  async markTeamOutboxDelivered(roomId: string, teamRunId: string, outboxId: string): Promise<TeamOutboxRecord> {
    return this.withLock(roomId, teamRunId, () => {
      const record = this.listTeamOutbox(roomId, teamRunId).find((item) => item.id === outboxId);
      if (!record) throw new TeamError("TEAM_INVALID_INPUT", "Team outbox record was not found.");
      if (record.status === "delivered") return record;
      const now = this.now();
      const delivered: TeamOutboxRecord = { ...record, status: "delivered", attempts: record.attempts + 1, updatedAt: now, deliveredAt: now };
      writeDurableLine(this.paths(roomId, teamRunId).outbox, JSON.stringify(delivered));
      return delivered;
    });
  }

  async markTeamOutboxFailed(roomId: string, teamRunId: string, outboxId: string, errorCode: string): Promise<TeamOutboxRecord> {
    return this.withLock(roomId, teamRunId, () => {
      const record = this.listTeamOutbox(roomId, teamRunId).find((item) => item.id === outboxId);
      if (!record) throw new TeamError("TEAM_INVALID_INPUT", "Team outbox record was not found.");
      const failed: TeamOutboxRecord = { ...record, status: "failed", attempts: record.attempts + 1, updatedAt: this.now(), errorCode };
      writeDurableLine(this.paths(roomId, teamRunId).outbox, JSON.stringify(failed));
      return failed;
    });
  }

  subscribeTeamRunEvents(roomId: string, listener: TeamRunListener): () => void {
    assertId(roomId, "room id");
    const set = listeners().get(roomId) ?? new Set<TeamRunListener>();
    set.add(listener);
    listeners().set(roomId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) listeners().delete(roomId);
    };
  }

  private broadcast(event: TeamRunEventEnvelope): void {
    for (const listener of listeners().get(event.roomId) ?? []) listener(event);
  }

  async recoverUnfinishedTeamRuns(): Promise<TeamRunState[]> {
    if (!existsSync(this.roomsRoot)) return [];
    const states: TeamRunState[] = [];
    for (const room of readdirSync(this.roomsRoot, { withFileTypes: true })) {
      if (!room.isDirectory() || !ID_PATTERN.test(room.name)) continue;
      for (const state of this.listTeamRuns(room.name, { limit: 500, includeTerminal: false })) states.push(state);
    }
    return states;
  }
}

export function getTeamRunStore(): TeamRunStore {
  return globalThis.__pioraTeamRunStore ??= new TeamRunStore();
}

export function resetTeamRunStoreForTests(): void {
  globalThis.__pioraTeamRunStore = undefined;
  globalThis.__pioraTeamRunListeners?.clear();
}

export const createTeamRun = (input: CreateTeamRunInput) => getTeamRunStore().createTeamRun(input);
export const getTeamRun = (roomId: string, teamRunId: string) => getTeamRunStore().getTeamRun(roomId, teamRunId);
export const listTeamRuns = (roomId: string, options?: { limit?: number; includeTerminal?: boolean }) => getTeamRunStore().listTeamRuns(roomId, options);
export const appendTeamRunEvents = (roomId: string, teamRunId: string, expectedRevision: number, events: readonly (AppendTeamEventInput | TeamRunEvent)[]) => getTeamRunStore().appendTeamRunEvents(roomId, teamRunId, expectedRevision, events);
export const listTeamRunEvents = (roomId: string, teamRunId: string, afterCursor?: number) => getTeamRunStore().listTeamRunEvents(roomId, teamRunId, afterCursor);
export const appendTeamOutbox = (roomId: string, teamRunId: string, input: Parameters<TeamRunStore["appendTeamOutbox"]>[2]) => getTeamRunStore().appendTeamOutbox(roomId, teamRunId, input);
export const markTeamOutboxDelivered = (roomId: string, teamRunId: string, outboxId: string) => getTeamRunStore().markTeamOutboxDelivered(roomId, teamRunId, outboxId);
export const subscribeTeamRunEvents = (roomId: string, listener: TeamRunListener) => getTeamRunStore().subscribeTeamRunEvents(roomId, listener);
export const recoverUnfinishedTeamRuns = () => getTeamRunStore().recoverUnfinishedTeamRuns();
