import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { join, relative } from "node:path";
import { filterFileEntries } from "./file-fuzzy.ts";

export type WorkspaceSearchMode = "files" | "content";

export interface WorkspaceSearchResult {
  path: string;
  line?: number;
  column?: number;
  preview?: string;
}

export interface WorkspaceSearchResponse {
  results: WorkspaceSearchResult[];
  truncated: boolean;
  timedOut: boolean;
  engine: "rg" | "node";
}

export const WORKSPACE_SEARCH_LIMIT = 1_000;
export const WORKSPACE_SEARCH_TIMEOUT_MS = 10_000;
export const WORKSPACE_SEARCH_MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_QUERY_LENGTH = 256;

interface IgnoreRule { negated: boolean; directoryOnly: boolean; regex: RegExp; }

export function normalizeWorkspaceSearchQuery(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MAX_QUERY_LENGTH);
}

function portablePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function globSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") { source += ".*"; index += 1; }
      else source += "[^/]*";
    } else if (character === "?") source += "[^/]";
    else source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return source;
}

export function parseGitIgnore(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of content.split(/\r?\n/)) {
    let pattern = raw.trim();
    if (!pattern || pattern.startsWith("#")) continue;
    const negated = pattern.startsWith("!");
    if (negated) pattern = pattern.slice(1);
    const directoryOnly = pattern.endsWith("/");
    pattern = pattern.replace(/^\//, "").replace(/\/$/, "");
    if (!pattern) continue;
    const nested = pattern.includes("/");
    rules.push({
      negated,
      directoryOnly,
      regex: new RegExp(nested ? `^${globSource(pattern)}(?:/.*)?$` : `(?:^|/)${globSource(pattern)}(?:/.*)?$`),
    });
  }
  return rules;
}

function isIgnored(path: string, directory: boolean, rules: IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if ((!rule.directoryOnly || directory || path.includes("/")) && rule.regex.test(path)) ignored = !rule.negated;
  }
  return ignored;
}

function parseContentMatch(line: string): WorkspaceSearchResult | null {
  try {
    const event = JSON.parse(line) as {
      type?: string;
      data?: {
        path?: { text?: string };
        lines?: { text?: string };
        line_number?: number;
        submatches?: Array<{ start?: number }>;
      };
    };
    if (event.type !== "match" || !event.data?.path?.text) return null;
    return {
      path: portablePath(event.data.path.text),
      line: event.data.line_number,
      column: (event.data.submatches?.[0]?.start ?? 0) + 1,
      preview: event.data.lines?.text?.replace(/[\r\n]+$/, "") ?? "",
    };
  } catch {
    return null;
  }
}

async function searchWithRipgrep(
  cwd: string,
  query: string,
  mode: WorkspaceSearchMode,
  signal?: AbortSignal,
): Promise<WorkspaceSearchResponse> {
  const args = mode === "files"
    ? ["--files", "--hidden", "--glob", "!.git/**", "--no-messages"]
    : ["--json", "--hidden", "--glob", "!.git/**", "--max-filesize", "10M", "--fixed-strings", "--no-messages", "--", query, "."];

  return await new Promise<WorkspaceSearchResponse>((resolveResult, reject) => {
    const child = spawn("rg", args, { cwd, shell: false, windowsHide: true });
    const results: WorkspaceSearchResult[] = [];
    const filePaths: string[] = [];
    let buffered = "";
    let timedOut = false;
    let truncated = false;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const finalResults = mode === "files"
        ? filterFileEntries(filePaths.map((path) => ({ path, isDir: false })), query, WORKSPACE_SEARCH_LIMIT)
            .map(({ path }) => ({ path }))
        : results;
      resolveResult({ results: finalResults, truncated, timedOut, engine: "rg" });
    };
    const abort = () => {
      timedOut = timedOut || !signal?.aborted;
      child.kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, WORKSPACE_SEARCH_TIMEOUT_MS);

    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline).replace(/\r$/, "");
        buffered = buffered.slice(newline + 1);
        if (mode === "files") {
          if (line) filePaths.push(portablePath(line));
          if (filePaths.length > 50_000) {
            truncated = true;
            child.kill();
            break;
          }
        } else {
          const match = parseContentMatch(line);
          if (match) results.push(match);
          if (results.length >= WORKSPACE_SEARCH_LIMIT) {
            truncated = true;
            child.kill();
            break;
          }
        }
        newline = buffered.indexOf("\n");
      }
    });
    child.once("error", reject);
    child.once("close", finish);
  });
}

async function collectFiles(root: string, deadline: number, output: string[], rules: IgnoreRule[], current = root): Promise<boolean> {
  if (Date.now() >= deadline || output.length >= 50_000) return false;
  let entries;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const entry of entries) {
    if (Date.now() >= deadline || output.length >= 50_000) return false;
    if (entry.name === ".git") continue;
    const absolute = join(current, entry.name);
    const relativePath = portablePath(relative(root, absolute));
    if (isIgnored(relativePath, entry.isDirectory(), rules)) continue;
    if (entry.isDirectory()) {
      if (!await collectFiles(root, deadline, output, rules, absolute)) return false;
    } else if (entry.isFile()) {
      output.push(relativePath);
    }
  }
  return true;
}

async function searchWithNode(cwd: string, query: string, mode: WorkspaceSearchMode): Promise<WorkspaceSearchResponse> {
  const deadline = Date.now() + WORKSPACE_SEARCH_TIMEOUT_MS;
  const files: string[] = [];
  const ignoreContent = await fs.readFile(join(cwd, ".gitignore"), "utf8").catch(() => "");
  const completed = await collectFiles(cwd, deadline, files, parseGitIgnore(ignoreContent));
  if (mode === "files") {
    return {
      results: filterFileEntries(files.map((path) => ({ path, isDir: false })), query, WORKSPACE_SEARCH_LIMIT).map(({ path }) => ({ path })),
      truncated: files.length >= 50_000,
      timedOut: !completed,
      engine: "node",
    };
  }

  const results: WorkspaceSearchResult[] = [];
  for (const path of files) {
    if (Date.now() >= deadline || results.length >= WORKSPACE_SEARCH_LIMIT) break;
    const absolute = join(cwd, path);
    let stat;
    try { stat = await fs.stat(absolute); } catch { continue; }
    if (stat.size > WORKSPACE_SEARCH_MAX_FILE_BYTES) continue;
    let content: string;
    try { content = await fs.readFile(absolute, "utf8"); } catch { continue; }
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length && results.length < WORKSPACE_SEARCH_LIMIT; index += 1) {
      const column = lines[index].toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
      if (column >= 0) results.push({ path, line: index + 1, column: column + 1, preview: lines[index] });
    }
  }
  return {
    results,
    truncated: results.length >= WORKSPACE_SEARCH_LIMIT,
    timedOut: Date.now() >= deadline,
    engine: "node",
  };
}

export async function searchWorkspace(
  cwd: string,
  query: string,
  mode: WorkspaceSearchMode,
  signal?: AbortSignal,
): Promise<WorkspaceSearchResponse> {
  try {
    return await searchWithRipgrep(cwd, query, mode, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return searchWithNode(cwd, query, mode);
  }
}
