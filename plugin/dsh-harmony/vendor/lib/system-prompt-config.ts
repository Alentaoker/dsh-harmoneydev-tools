import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { writePrivateFileAtomicSync } from "./atomic-file";
import type { SystemPromptSelection, SystemPromptTemplate } from "./system-prompt-types";

const SYSTEM_PROMPT_CONFIG_VERSION = 2;
const LEGACY_DEFAULT_TEMPLATE_ID = "legacy-global-default";
export const SYSTEM_PROMPT_MAX_LENGTH = 100_000;
export const SYSTEM_PROMPT_TEMPLATE_NAME_MAX_LENGTH = 80;
export const SYSTEM_PROMPT_TEMPLATE_MAX_COUNT = 100;

export interface SystemPromptConfig {
  version: typeof SYSTEM_PROMPT_CONFIG_VERSION;
  templates: SystemPromptTemplate[];
  defaultTemplateId: string | null;
  selectorVisible: boolean;
  updatedAt: string | null;
}

export interface ResolvedSystemPromptSelection {
  source: SystemPromptSelection["mode"];
  templateId: string | null;
  templateName: string | null;
  prompt: string | null;
}

interface LegacySystemPromptConfig {
  version?: unknown;
  prompt?: unknown;
  updatedAt?: unknown;
}

function emptyConfig(): SystemPromptConfig {
  return {
    version: SYSTEM_PROMPT_CONFIG_VERSION,
    templates: [],
    defaultTemplateId: null,
    selectorVisible: true,
    updatedAt: null,
  };
}

function validatePrompt(prompt: unknown): string {
  if (typeof prompt !== "string") throw new Error("System prompt must be a string.");
  if (prompt.length > SYSTEM_PROMPT_MAX_LENGTH) {
    throw new Error(`System prompt must not exceed ${SYSTEM_PROMPT_MAX_LENGTH} characters.`);
  }
  if (prompt.includes("\0")) throw new Error("System prompt must not contain null characters.");
  return prompt;
}

function validateTemplateName(name: unknown): string {
  if (typeof name !== "string") throw new Error("Template name must be a string.");
  const normalized = name.replace(/[\r\n]+/g, " ").trim();
  if (!normalized) throw new Error("Template name is required.");
  if (normalized.length > SYSTEM_PROMPT_TEMPLATE_NAME_MAX_LENGTH) {
    throw new Error(`Template name must not exceed ${SYSTEM_PROMPT_TEMPLATE_NAME_MAX_LENGTH} characters.`);
  }
  return normalized;
}

function isTemplateId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value);
}

function normalizeStoredTemplate(value: unknown): SystemPromptTemplate | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<SystemPromptTemplate>;
  if (!isTemplateId(source.id)) return null;
  try {
    return {
      id: source.id,
      name: validateTemplateName(source.name),
      prompt: validatePrompt(source.prompt),
      createdAt: typeof source.createdAt === "string" ? source.createdAt : new Date(0).toISOString(),
      updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

function migrateLegacyConfig(parsed: LegacySystemPromptConfig): SystemPromptConfig {
  if (parsed.prompt === null || parsed.prompt === undefined) return emptyConfig();
  try {
    const prompt = validatePrompt(parsed.prompt);
    const timestamp = typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString();
    return {
      version: SYSTEM_PROMPT_CONFIG_VERSION,
      templates: [{
        id: LEGACY_DEFAULT_TEMPLATE_ID,
        name: "Global default",
        prompt,
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
      defaultTemplateId: LEGACY_DEFAULT_TEMPLATE_ID,
      selectorVisible: true,
      updatedAt: timestamp,
    };
  } catch {
    return emptyConfig();
  }
}

export function systemPromptConfigPath(agentDir = getAgentDir()): string {
  return resolve(agentDir, "piora", "system-prompt.json");
}

export function readSystemPromptConfig(path = systemPromptConfigPath()): SystemPromptConfig {
  try {
    if (!existsSync(path)) return emptyConfig();
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LegacySystemPromptConfig;
    if (parsed.version === 1) return migrateLegacyConfig(parsed);
    const current = parsed as Partial<SystemPromptConfig>;
    if (current.version !== SYSTEM_PROMPT_CONFIG_VERSION || !Array.isArray(current.templates)) return emptyConfig();
    const templates: SystemPromptTemplate[] = [];
    const ids = new Set<string>();
    for (const candidate of current.templates.slice(0, SYSTEM_PROMPT_TEMPLATE_MAX_COUNT)) {
      const template = normalizeStoredTemplate(candidate);
      if (!template || ids.has(template.id)) continue;
      ids.add(template.id);
      templates.push(template);
    }
    return {
      version: SYSTEM_PROMPT_CONFIG_VERSION,
      templates,
      defaultTemplateId: isTemplateId(current.defaultTemplateId) && ids.has(current.defaultTemplateId)
        ? current.defaultTemplateId
        : null,
      selectorVisible: current.selectorVisible !== false,
      updatedAt: typeof current.updatedAt === "string" ? current.updatedAt : null,
    };
  } catch {
    return emptyConfig();
  }
}

function persistSystemPromptConfig(config: SystemPromptConfig, path = systemPromptConfigPath()): SystemPromptConfig {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

function withTimestamp(config: SystemPromptConfig, patch: Partial<SystemPromptConfig>): SystemPromptConfig {
  return {
    ...config,
    ...patch,
    version: SYSTEM_PROMPT_CONFIG_VERSION,
    updatedAt: new Date().toISOString(),
  };
}

function assertUniqueName(config: SystemPromptConfig, name: string, exceptId?: string): void {
  const normalized = name.toLocaleLowerCase();
  if (config.templates.some((template) => template.id !== exceptId && template.name.toLocaleLowerCase() === normalized)) {
    throw new Error(`A system prompt template named "${name}" already exists.`);
  }
}

export function createSystemPromptTemplate(
  name: unknown,
  prompt: unknown,
  path = systemPromptConfigPath(),
): SystemPromptConfig {
  const config = readSystemPromptConfig(path);
  if (config.templates.length >= SYSTEM_PROMPT_TEMPLATE_MAX_COUNT) {
    throw new Error(`No more than ${SYSTEM_PROMPT_TEMPLATE_MAX_COUNT} system prompt templates are allowed.`);
  }
  const normalizedName = validateTemplateName(name);
  assertUniqueName(config, normalizedName);
  const timestamp = new Date().toISOString();
  const template: SystemPromptTemplate = {
    id: randomUUID(),
    name: normalizedName,
    prompt: validatePrompt(prompt),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return persistSystemPromptConfig(withTimestamp(config, {
    templates: [...config.templates, template],
    defaultTemplateId: config.defaultTemplateId ?? template.id,
  }), path);
}

export function updateSystemPromptTemplate(
  id: unknown,
  input: { name?: unknown; prompt?: unknown },
  path = systemPromptConfigPath(),
): SystemPromptConfig {
  if (!isTemplateId(id)) throw new Error("Invalid system prompt template id.");
  const config = readSystemPromptConfig(path);
  const current = config.templates.find((template) => template.id === id);
  if (!current) throw new Error("System prompt template not found.");
  const name = input.name === undefined ? current.name : validateTemplateName(input.name);
  assertUniqueName(config, name, id);
  const prompt = input.prompt === undefined ? current.prompt : validatePrompt(input.prompt);
  const templates = config.templates.map((template) => template.id === id
    ? { ...template, name, prompt, updatedAt: new Date().toISOString() }
    : template);
  return persistSystemPromptConfig(withTimestamp(config, { templates }), path);
}

export function deleteSystemPromptTemplate(id: unknown, path = systemPromptConfigPath()): SystemPromptConfig {
  if (!isTemplateId(id)) throw new Error("Invalid system prompt template id.");
  const config = readSystemPromptConfig(path);
  if (!config.templates.some((template) => template.id === id)) throw new Error("System prompt template not found.");
  return persistSystemPromptConfig(withTimestamp(config, {
    templates: config.templates.filter((template) => template.id !== id),
    defaultTemplateId: config.defaultTemplateId === id ? null : config.defaultTemplateId,
  }), path);
}

export function setDefaultSystemPromptTemplate(id: unknown, path = systemPromptConfigPath()): SystemPromptConfig {
  if (id !== null && !isTemplateId(id)) throw new Error("Invalid default system prompt template id.");
  const config = readSystemPromptConfig(path);
  if (id !== null && !config.templates.some((template) => template.id === id)) {
    throw new Error("System prompt template not found.");
  }
  return persistSystemPromptConfig(withTimestamp(config, { defaultTemplateId: id }), path);
}

export function setSystemPromptSelectorVisible(
  visible: unknown,
  path = systemPromptConfigPath(),
): SystemPromptConfig {
  if (typeof visible !== "boolean") throw new Error("System prompt selector visibility must be a boolean.");
  const config = readSystemPromptConfig(path);
  return persistSystemPromptConfig(withTimestamp(config, { selectorVisible: visible }), path);
}

/** Backward-compatible mutation for older clients of PUT /api/system-prompt. */
export function writeSystemPromptConfig(prompt: string | null, path = systemPromptConfigPath()): SystemPromptConfig {
  if (prompt === null) return setDefaultSystemPromptTemplate(null, path);
  const validated = validatePrompt(prompt);
  const config = readSystemPromptConfig(path);
  const timestamp = new Date().toISOString();
  const existing = config.templates.find((template) => template.id === LEGACY_DEFAULT_TEMPLATE_ID);
  const legacy: SystemPromptTemplate = existing
    ? { ...existing, prompt: validated, updatedAt: timestamp }
    : {
        id: LEGACY_DEFAULT_TEMPLATE_ID,
        name: "Global default",
        prompt: validated,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
  const templates = existing
    ? config.templates.map((template) => template.id === legacy.id ? legacy : template)
    : [...config.templates, legacy];
  return persistSystemPromptConfig(withTimestamp(config, {
    templates,
    defaultTemplateId: legacy.id,
  }), path);
}

export function resolveSystemPromptSelection(
  config: SystemPromptConfig,
  selection: SystemPromptSelection,
): ResolvedSystemPromptSelection {
  const templateId = selection.mode === "template" ? selection.templateId : config.defaultTemplateId;
  if (selection.mode === "template" && !isTemplateId(templateId)) {
    throw new Error("Invalid system prompt template id.");
  }
  const template = templateId
    ? config.templates.find((candidate) => candidate.id === templateId)
    : undefined;
  if (templateId && !template) throw new Error("System prompt template not found.");
  return {
    source: selection.mode,
    templateId: template?.id ?? null,
    templateName: template?.name ?? null,
    prompt: template?.prompt ?? null,
  };
}
