export type HarmonyCheckKind = "arkts" | "lint";
export type HarmonyCheckSeverity = "error" | "warning" | "suggestion" | "info";
export type HarmonyCheckStatus = "passed" | "issues" | "incomplete" | "cancelled";

export interface HarmonyCheckDiagnostic {
  source: HarmonyCheckKind;
  file: string;
  relativeFile: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: HarmonyCheckSeverity;
  code?: string;
  rule?: string;
  message: string;
}

export interface HarmonyCheckStep {
  kind: HarmonyCheckKind;
  status: HarmonyCheckStatus;
  durationMs: number;
  diagnostics: HarmonyCheckDiagnostic[];
  message?: string;
  filesChecked?: number;
}

export interface HarmonyCheckSummary {
  errors: number;
  warnings: number;
  suggestions: number;
  info: number;
  total: number;
}

export interface HarmonyCheckReport {
  schemaVersion: 1;
  id: string;
  projectRoot: string;
  product?: string;
  status: HarmonyCheckStatus;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  sourceFingerprint: string;
  checks: HarmonyCheckStep[];
  diagnostics: HarmonyCheckDiagnostic[];
  summary: HarmonyCheckSummary;
  toolchain: HarmonyCheckEnvironment;
}

export interface HarmonyCheckEnvironment {
  platformSupported: boolean;
  cliVersion: string;
  cliPath: string;
  studioPath?: string;
  studioVersion?: string;
  source?: "manual" | "environment" | "registry" | "default";
  ready: boolean;
  error?: string;
}

export interface HarmonyCheckConfig {
  arktsEnabled: boolean;
  lintEnabled: boolean;
  checkAfterAgentEdits: boolean;
  maxAgentIterations: number;
  timeoutMs: number;
  studioPath?: string;
  products: Record<string, string>;
}
