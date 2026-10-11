import { spawn } from "node:child_process";
import { availableParallelism, tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import OpenCC from "opencc-js";

const MODEL_FILE = "ggml-base-q5_1.bin";
const EXECUTABLE_FILE = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
const MAX_PROCESS_OUTPUT = 64 * 1024;
const TRANSCRIPTION_TIMEOUT_MS = 120_000;
const toSimplifiedChinese = OpenCC.Converter({ from: "twp", to: "cn" });

declare global {
  var __pioraWhisperBusy: boolean | undefined;
}

export class WhisperBusyError extends Error {}
export class WhisperUnavailableError extends Error {}

export function resolveWhisperDirectory(): string | null {
  const configured = process.env.PIORA_WHISPER_DIR?.trim();
  const candidates = [
    configured,
    join(process.cwd(), "desktop", "build", "whisper"),
    join(process.cwd(), "whisper"),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const directory = resolve(candidate);
    if (existsSync(join(directory, EXECUTABLE_FILE)) && existsSync(join(directory, MODEL_FILE))) return directory;
  }
  return null;
}

export function isWhisperAvailable(): boolean {
  return resolveWhisperDirectory() !== null;
}

export function validateWhisperWav(bytes: Uint8Array): void {
  if (bytes.byteLength < 44) throw new Error("Audio is too short");
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE" || ascii(12, 4) !== "fmt ") {
    throw new Error("Audio must be a PCM WAV file");
  }
  if (view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== 16_000 || view.getUint16(34, true) !== 16) {
    throw new Error("Audio must be 16 kHz mono PCM16 WAV");
  }
}

export function simplifyChineseTranscript(text: string): string {
  return toSimplifiedChinese(text);
}

function runWhisper(executable: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, shell: false });
    let output = "";
    const collect = (chunk: Buffer) => {
      if (output.length < MAX_PROCESS_OUTPUT) output += chunk.toString("utf8").slice(0, MAX_PROCESS_OUTPUT - output.length);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timeout = setTimeout(() => child.kill("SIGKILL"), TRANSCRIPTION_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolveRun();
      else rejectRun(new Error(`Whisper exited with code ${String(code)} signal ${String(signal)}: ${output.trim()}`));
    });
  });
}

export async function transcribeWhisperWav(bytes: Uint8Array, language: "zh" | "en"): Promise<string> {
  validateWhisperWav(bytes);
  const directory = resolveWhisperDirectory();
  if (!directory) throw new WhisperUnavailableError("Bundled Whisper resources are unavailable");
  if (globalThis.__pioraWhisperBusy) throw new WhisperBusyError("A transcription is already running");
  globalThis.__pioraWhisperBusy = true;

  let workDirectory: string | null = null;
  try {
    workDirectory = await mkdtemp(join(tmpdir(), "piora-whisper-"));
    const inputPath = join(workDirectory, "voice.wav");
    const outputPrefix = join(workDirectory, "transcript");
    await writeFile(inputPath, bytes);
    const threads = String(Math.max(1, Math.min(4, availableParallelism() - 1)));
    await runWhisper(join(directory, EXECUTABLE_FILE), [
      "-m", join(directory, MODEL_FILE),
      "-f", inputPath,
      "-l", language,
      ...(language === "zh" ? ["--prompt", "以下是普通话的简体中文转写。"] : []),
      "-t", threads,
      "-nt",
      "-np",
      "-sns",
      "-otxt",
      "-of", outputPrefix,
    ], directory);
    const text = (await readFile(`${outputPrefix}.txt`, "utf8"))
      .replace(/\[(?:BLANK_AUDIO|MUSIC|NOISE|SILENCE)\]/gi, "")
      .trim();
    return language === "zh" ? simplifyChineseTranscript(text) : text;
  } finally {
    globalThis.__pioraWhisperBusy = false;
    if (workDirectory) await rm(workDirectory, { recursive: true, force: true }).catch(() => {});
  }
}
