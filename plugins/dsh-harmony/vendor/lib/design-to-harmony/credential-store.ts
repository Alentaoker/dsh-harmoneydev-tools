import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { DesignToHarmonyError } from "./errors";
import { designToHarmonyDataRoot } from "./data-root";
import type { DesignCredentialStatus } from "./types";

interface StoredCredentialFile {
  schema: 1;
  figma?: {
    token: string;
    updatedAt: string;
  };
}

function credentialPath(root = designToHarmonyDataRoot()): string {
  return join(resolve(root), "credentials.json");
}

function parseStoredCredentialFile(value: unknown): StoredCredentialFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { schema: 1 };
  const record = value as Record<string, unknown>;
  if (record.schema !== 1) return { schema: 1 };
  const figma = record.figma;
  if (!figma || typeof figma !== "object" || Array.isArray(figma)) return { schema: 1 };
  const provider = figma as Record<string, unknown>;
  if (typeof provider.token !== "string" || typeof provider.updatedAt !== "string") return { schema: 1 };
  return { schema: 1, figma: { token: provider.token, updatedAt: provider.updatedAt } };
}

function readCredentialFile(root?: string): StoredCredentialFile {
  const path = credentialPath(root);
  if (!existsSync(path)) return { schema: 1 };
  try {
    return parseStoredCredentialFile(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return { schema: 1 };
  }
}

function normalizeToken(value: unknown): string {
  if (typeof value !== "string") {
    throw new DesignToHarmonyError("INVALID_ARGUMENT", "Figma access token is required", { status: 400 });
  }
  const token = value.trim();
  if (token.length < 8 || token.length > 8_192 || /[\r\n\0]/.test(token)) {
    throw new DesignToHarmonyError("INVALID_ARGUMENT", "Figma access token is invalid", { status: 400 });
  }
  return token;
}

export function designCredentialStatus(root?: string): DesignCredentialStatus {
  const stored = readCredentialFile(root);
  return {
    provider: "figma",
    configured: Boolean(stored.figma?.token),
    ...(stored.figma?.updatedAt ? { updatedAt: stored.figma.updatedAt } : {}),
  };
}

export function readFigmaAccessToken(root?: string): string {
  const token = readCredentialFile(root).figma?.token;
  if (!token) {
    throw new DesignToHarmonyError("CREDENTIAL_MISSING", "Connect Figma before importing a design file", { status: 409 });
  }
  return token;
}

export function writeFigmaAccessToken(value: unknown, root?: string, now = new Date()): DesignCredentialStatus {
  const token = normalizeToken(value);
  const path = credentialPath(root);
  const updatedAt = now.toISOString();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(path, `${JSON.stringify({ schema: 1, figma: { token, updatedAt } }, null, 2)}\n`);
  return { provider: "figma", configured: true, updatedAt };
}

export function removeFigmaAccessToken(root?: string): DesignCredentialStatus {
  const path = credentialPath(root);
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { provider: "figma", configured: false };
}
