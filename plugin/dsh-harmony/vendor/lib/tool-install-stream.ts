import type { ToolRuntimeInfo } from "./tool-runtime";
import type { ToolInstallEvent } from "./tool-install-progress";

type Status = { type: string; message: string };

export function createToolInstallResponse(
  tool: "fd" | "rg",
  install: (onStatus: (status: Status) => void) => Promise<{ path: string | null; status: "installed" | "unavailable" }>,
  inspect: () => ToolRuntimeInfo[],
): Response {
  let closed = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: ToolInstallEvent) => {
        if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      send({ type: "progress", phase: "checking" });
      void (async () => {
        let failure: string | undefined;
        try {
          const result = await install((status) => {
            if (status.type === "warning") failure = status.message;
            else if (/downloading/i.test(status.message)) send({ type: "progress", phase: "downloading" });
          });
          if (result.status !== "installed") throw new Error(failure ?? "Tool installation failed");
          send({ type: "progress", phase: "verifying" });
          const runtime = inspect();
          if (runtime.find((item) => item.id === tool)?.status !== "available") {
            throw new Error("The downloaded tool could not be executed. Check the tool status before retrying.");
          }
          send({ type: "done", runtime });
        } catch (error) {
          send({ type: "error", error: (error instanceof Error ? error.message : String(error)).slice(0, 4096) });
        } finally {
          if (!closed) { closed = true; controller.close(); }
        }
      })();
    },
    // The SDK cannot cancel downloads. Detach the client without interrupting its file writes.
    cancel() { closed = true; },
  });
  return new Response(stream, { headers: {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "X-Accel-Buffering": "no",
  } });
}
