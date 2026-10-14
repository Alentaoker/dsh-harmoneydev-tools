import { getHarmonyDeviceManager } from "@/lib/harmony";
import { publicManagerEvent, requireHarmonyAccess } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request);
  if (denied) return denied;
  const encoder = new TextEncoder();
  const manager = getHarmonyDeviceManager();
  let dispose: () => void = () => undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        dispose();
        if (heartbeat) clearInterval(heartbeat);
        try { controller.close(); } catch { /* Already closed by the client. */ }
      };
      dispose = manager.subscribe((event) => send(publicManagerEvent(event)));
      heartbeat = setInterval(() => send({ type: "heartbeat", timestamp: new Date().toISOString() }), 15_000);
      send({ type: "connected", timestamp: new Date().toISOString() });
      request.signal.addEventListener("abort", close, { once: true });
    },
    cancel() {
      dispose();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-cache, no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
