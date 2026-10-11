import { containsAudibleSpeech, mergeAudioChunks } from "./voice-audio";

type Segment = { chunks: Float32Array[]; length: number; silence: number; voiced: boolean; final: boolean; requested: number; text: string };
const segment = (): Segment => ({ chunks: [], length: 0, silence: 0, voiced: false, final: false, requested: 0, text: "" });

/** Bounded utterances with replaceable partial results and one inference in flight. */
export class LiveDictation {
  private segments: Segment[] = [segment()];
  private committed: string[] = [];
  private pending: Promise<void> | null = null;
  private cancelled = false;
  private ended = false;
  private failure: unknown;
  private emitted = "";

  constructor(private options: {
    sampleRate: number;
    language: "zh" | "en";
    transcribe: (samples: Float32Array) => Promise<string>;
    onText: (text: string) => void;
    onError: (error: unknown) => void;
  }) {}

  push(samples: Float32Array): void {
    if (this.cancelled || this.ended) return;
    const current = this.segments[this.segments.length - 1];
    current.chunks.push(samples);
    current.length += samples.length;
    const voiced = containsAudibleSpeech(samples, this.options.sampleRate);
    current.voiced ||= voiced;
    current.silence = voiced ? 0 : current.silence + samples.length;
    if ((!current.voiced && current.length >= this.options.sampleRate)
      || (current.voiced && current.silence >= this.options.sampleRate * 0.5)
      || current.length >= this.options.sampleRate * 12) {
      current.final = true;
      this.segments.push(segment());
    }
    this.pump();
  }

  private pump(): void {
    if (this.pending || this.cancelled) return;
    this.pending = this.drain().catch(error => {
      if (!this.cancelled) { this.failure = error; this.cancelled = true; this.options.onError(error); }
    }).finally(() => { this.pending = null; });
  }

  private async drain(): Promise<void> {
    while (!this.cancelled && this.segments.length) {
      const current = this.segments[0];
      if (!current.voiced) {
        if (!current.final) return;
        this.segments.shift();
        continue;
      }
      if (!current.final && current.length - current.requested < this.options.sampleRate * 0.9) return;
      if (current.length !== current.requested) {
        const length = current.length;
        const text = (await this.options.transcribe(mergeAudioChunks(current.chunks))).trim();
        if (this.cancelled) return;
        current.requested = length;
        current.text = text;
        const combined = [...this.committed, text].filter(Boolean).join(this.options.language === "zh" ? "" : " ");
        if (combined !== this.emitted) { this.emitted = combined; this.options.onText(combined); }
      }
      // A pause/stop can arrive while an interim request is running. Decode
      // any remaining samples before committing, so the last word is retained.
      if (current.final && current.requested === current.length) {
        if (current.text) this.committed.push(current.text);
        this.segments.shift();
      } else if (!current.final) return;
    }
  }

  async finish(): Promise<boolean> {
    this.ended = true;
    for (const current of this.segments) current.final = true;
    await this.pending;
    if (!this.cancelled) { this.pump(); await this.pending; }
    if (this.failure) throw this.failure;
    return !!this.emitted;
  }

  cancel(): void { this.cancelled = true; this.segments = []; }
}
