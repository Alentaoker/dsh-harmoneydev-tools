const RUNTIME_VERIFICATION_COMMANDS = [
  { pattern: /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:\s|$)/i, label: "test suite" },
  { pattern: /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*node\s+--test(?:\s|$)/i, label: "Node.js test suite" },
  { pattern: /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*pytest(?:\s|$)/i, label: "Python test suite" },
  { pattern: /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*cargo\s+test(?:\s|$)/i, label: "Rust test suite" },
  { pattern: /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*go\s+test(?:\s|$)/i, label: "Go test suite" },
  { pattern: /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*dotnet\s+test(?:\s|$)/i, label: ".NET test suite" },
  { pattern: /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:npm|pnpm|yarn|bun)\s+run\s+typecheck(?:\s|$)/i, label: "typecheck" },
  { pattern: /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:npm|pnpm|yarn|bun)\s+run\s+lint(?:\s|$)/i, label: "lint check" },
  { pattern: /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*tsc\s+--noEmit(?:\s|$)/i, label: "TypeScript typecheck" },
  { pattern: /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*eslint(?:\s|$)/i, label: "ESLint check" },
  { pattern: /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*git\s+diff\s+--check(?:\s|$)/i, label: "Git diff integrity check" },
] as const;

export function runtimeToolArgument(args: unknown, keys: readonly string[]): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 2_000);
  }
  return undefined;
}

export function runtimeVerificationLabel(command: string): string | undefined {
  if (/[;\r\n|]/.test(command)) return undefined;
  const segments = command.split("&&").map((segment) => segment.trim());
  if (segments.some((segment) => !segment || segment.includes("&"))) return undefined;
  for (const segment of segments) {
    const match = RUNTIME_VERIFICATION_COMMANDS.find(({ pattern }) => pattern.test(segment));
    if (match) return match.label;
  }
  return undefined;
}

export function runtimeToolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text : "").join("\n");
}
