export type SSHAuth =
  | { type: "password"; password: string }
  | { type: "privateKey"; privateKey: string; passphrase?: string };

export interface SSHConnectionOptions {
  host: string;
  port?: number;
  username: string;
  auth: SSHAuth;
  hostFingerprint?: string;
  cols?: number;
  rows?: number;
}

export interface SSHSessionSnapshot {
  id: string;
  hostId?: string;
  hostName?: string;
  ownerSessionId?: string;
  host: string;
  port: number;
  username: string;
  cwd: string;
  connected: boolean;
  busy: boolean;
  output: string;
  mode: "independent" | "agent-controlled";
  hostFingerprint?: string;
  agentSessionId?: string;
}
export type SSHSessionSummary = Omit<SSHSessionSnapshot, "output">;

export type SSHSessionEvent =
  | { type: "snapshot"; snapshot: SSHSessionSnapshot }
  | { type: "output"; data: string }
  | { type: "status"; connected: boolean; error?: string }
  | { type: "busy"; busy: boolean }
  | { type: "clear" }
  | { type: "cwd"; cwd: string };

export interface SSHFileEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "other";
  size: number;
  modifiedAt: number | null;
}
