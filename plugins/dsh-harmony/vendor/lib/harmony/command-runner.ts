import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import { HarmonyError } from "./errors";

export interface CommandResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  durationMs: number;
}

export interface RunCommandOptions {
  executable: string;
  args: readonly string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  operation?: string;
}

export type CommandExecutor = (options: RunCommandOptions) => Promise<CommandResult>;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export const runCommand: CommandExecutor = async (options) => {
  if (!isAbsolute(options.executable)) {
    throw new HarmonyError("HDC_INVALID", "Device executables must use an absolute path");
  }
  if (options.signal?.aborted) {
    throw new HarmonyError("COMMAND_ABORTED", "Device operation was cancelled", { retryable: true });
  }

  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = Math.max(1, options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
  const started = Date.now();

  return await new Promise<CommandResult>((resolve, reject) => {
    let settled = false;
    let totalOutput = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const child = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finishError = (error: HarmonyError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      child.kill();
      reject(error);
    };
    const collect = (target: Buffer[], chunk: Buffer): void => {
      totalOutput += chunk.length;
      if (totalOutput > maxOutputBytes) {
        finishError(new HarmonyError("COMMAND_OUTPUT_LIMIT", "Device command exceeded its output limit", {
          details: { operation: options.operation, maxOutputBytes },
        }));
        return;
      }
      target.push(Buffer.from(chunk));
    };
    const abort = (): void => {
      finishError(new HarmonyError("COMMAND_ABORTED", "Device operation was cancelled", { retryable: true }));
    };
    const timer = setTimeout(() => {
      finishError(new HarmonyError("COMMAND_TIMEOUT", "Device command timed out", {
        details: { operation: options.operation, timeoutMs },
        retryable: true,
      }));
    }, timeoutMs);
    timer.unref?.();

    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => {
      finishError(new HarmonyError("COMMAND_FAILED", "Unable to start device command", {
        cause: error,
        details: { operation: options.operation },
        retryable: true,
      }));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      const result: CommandResult = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode: code ?? -1,
        durationMs: Date.now() - started,
      };
      if (result.exitCode !== 0) {
        reject(new HarmonyError("COMMAND_FAILED", "Device command failed", {
          details: { operation: options.operation, exitCode: result.exitCode },
          retryable: true,
        }));
        return;
      }
      resolve(result);
    });
  });
};
