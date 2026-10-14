import type { ToolRuntimeInfo } from "./tool-runtime";

export type ToolInstallPhase = "checking" | "downloading" | "verifying";
export type ToolInstallEvent =
  | { type: "progress"; phase: ToolInstallPhase }
  | { type: "done"; runtime: ToolRuntimeInfo[] }
  | { type: "error"; error: string };

/** POST response records can span arbitrary network and UTF-8 chunk boundaries. */
export async function readToolInstallProgress(response: Response, onEvent: (event: ToolInstallEvent) => void): Promise<void> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("Installation stream is unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  function consume(line: string): boolean {
    if (!line.trim()) return false;
    const event = JSON.parse(line) as ToolInstallEvent;
    onEvent(event);
    if (event.type === "error") throw new Error(event.error);
    return event.type === "done";
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, boundary);
        pending = pending.slice(boundary + 1);
        if (consume(line)) return;
      }
      if (done) {
        if (consume(pending)) return;
        throw new Error("Installation connection ended before completion. Check the tool status before retrying.");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
