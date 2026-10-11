/** Transient server-owned estimates; never written into SDK messages or history. */
export interface StreamingMetrics {
  generation: number;
  tokensPerSecond: number | null;
}

type Event = { type: string; [key: string]: unknown };
type Message = { role: string; content: Array<Record<string, unknown>>; [key: string]: unknown };
const WINDOW_MS = 5_000;

function contentLength(message: Message): number {
  return message.content.reduce((total, block) => {
    if (block.type === "text") return total + (typeof block.text === "string" ? block.text.length : 0);
    if (block.type === "thinking") return total + (typeof block.thinking === "string" ? block.thinking.length : 0);
    if (block.type === "toolCall") return total + JSON.stringify(block.arguments ?? block.input ?? {}).length;
    return total;
  }, 0);
}

/** One tracker per live AgentSession, sampled even when no browser is listening. */
export class StreamingMetricsTracker {
  private generation = 0;
  private message: Message | null = null;
  private chars = 0;
  private samples: Array<{ at: number; chars: number }> = [];

  update(event: Event, now = Date.now()): void {
    const message = event.message as Message | undefined;
    if (event.type === "agent_start" || event.type === "agent_end"
      || (event.type === "message_end" && message?.role === "assistant")) {
      this.message = null;
      this.samples = [];
      this.chars = 0;
      return;
    }
    if ((event.type !== "message_start" && event.type !== "message_update")
      || message?.role !== "assistant" || !Array.isArray(message.content)) return;
    if (event.type === "message_start" || !this.message) {
      this.generation += 1;
      this.samples = [];
      this.chars = contentLength(message);
    } else {
      const update = event.assistantMessageEvent as { type?: string; delta?: unknown } | undefined;
      // Tool argument deltas avoid serializing the growing JSON on every token.
      this.chars = typeof update?.delta === "string" && ["text_delta", "thinking_delta", "toolcall_delta"].includes(update.type ?? "")
        ? this.chars + update.delta.length : contentLength(message);
    }
    this.message = message;
    if (this.chars === 0) return;
    const last = this.samples.at(-1);
    // Exclude the first chunk: its generation time is unknown. Keep that first
    // baseline, then bucket later samples to bound memory on long responses.
    if (last && this.samples.length > 1 && Math.floor(now / 100) === Math.floor(last.at / 100)) this.samples[this.samples.length - 1] = { at: now, chars: this.chars };
    else this.samples.push({ at: now, chars: this.chars });
    while (this.samples.length > 2 && this.samples[1].at <= now - WINDOW_MS) this.samples.shift();
  }

  getMetrics(now = Date.now()): StreamingMetrics | null {
    if (!this.message) return null;
    const cutoff = now - WINDOW_MS;
    const base = this.samples.findLast(sample => sample.at <= cutoff) ?? this.samples[0];
    const last = this.samples.at(-1);
    const elapsed = base ? now - Math.max(base.at, cutoff) : 0;
    const tokensPerSecond = !base || !last || elapsed < 500 ? null
      : last.at <= cutoff ? 0 : Math.max(0, (last.chars - base.chars) / 4 / (elapsed / 1_000));
    return { generation: this.generation, tokensPerSecond };
  }

  getMessage(now = Date.now()): Message | null {
    return this.message ? { ...this.message, streamingMetrics: this.getMetrics(now) } : null;
  }
}
