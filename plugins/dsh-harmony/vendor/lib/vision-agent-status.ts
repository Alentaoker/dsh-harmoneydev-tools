export const VISION_AGENT_STATUS_KEY = "piora-vision-agent";

export type VisionAgentStatus =
  | { phase: "analyzing"; imageCount: number }
  | { phase: "ready"; imageCount: number }
  | { phase: "failed"; reason: string };

function normalizeImageCount(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 999) : 1;
}

/**
 * Pi's extension UI transports statuses as text. Keep a stable, human-readable
 * wire format so Piora can recover richer visual-agent phases without adding a
 * second event channel, while other Pi clients still show useful copy.
 */
export function formatVisionAgentStatus(status: VisionAgentStatus): string {
  if (status.phase === "failed") return `Visual model failed: ${status.reason}`;
  const imageCount = normalizeImageCount(status.imageCount);
  if (status.phase === "ready") {
    return imageCount === 1
      ? "Image analyzed. Generating response…"
      : `${imageCount} images analyzed. Generating response…`;
  }
  return imageCount === 1 ? "Analyzing image…" : `Analyzing ${imageCount} images…`;
}

export function parseVisionAgentStatus(text: unknown): VisionAgentStatus | null {
  if (typeof text !== "string") return null;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  const failure = /^Visual model failed:\s*(.+)$/i.exec(normalized);
  if (failure) return { phase: "failed", reason: failure[1].trim() };

  const analyzingMany = /^Analyzing (\d+) images(?:…|\.\.\.)?$/i.exec(normalized);
  if (analyzingMany) return { phase: "analyzing", imageCount: normalizeImageCount(Number(analyzingMany[1])) };
  if (/^(?:Analyzing image|Understanding images)(?:…|\.\.\.)?$/i.test(normalized)) {
    return { phase: "analyzing", imageCount: 1 };
  }

  const readyMany = /^(\d+) images analyzed\. Generating response(?:…|\.\.\.)?$/i.exec(normalized);
  if (readyMany) return { phase: "ready", imageCount: normalizeImageCount(Number(readyMany[1])) };
  if (/^Image analyzed\. Generating response(?:…|\.\.\.)?$/i.test(normalized)) {
    return { phase: "ready", imageCount: 1 };
  }

  return null;
}
