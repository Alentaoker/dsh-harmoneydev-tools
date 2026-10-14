import type { SSHSession } from "./session-manager";

export class SSHBindingError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}

/** Agent access is checked again for every tool call; local Bash is never replaced. */
export function changeSSHBinding(session: SSHSession, agentSessionId?: string): void {
  const snapshot = session.snapshot();
  if (snapshot.agentSessionId === agentSessionId) return;
  if (snapshot.busy) throw new SSHBindingError("Wait for the SSH command to finish or stop it before changing the task link", "busy");
  if (agentSessionId && !snapshot.connected) throw new SSHBindingError("SSH is disconnected", "connection");
  if (agentSessionId && session.ownerSessionId && session.ownerSessionId !== agentSessionId) throw new SSHBindingError("SSH belongs to another task", "alreadyBound");
  if (agentSessionId) session.bindAgent(agentSessionId);
  else session.unbindAgent();
}
