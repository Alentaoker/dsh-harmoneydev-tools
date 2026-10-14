export type DesignToHarmonyErrorCode =
  | "INVALID_ARGUMENT"
  | "PROJECT_ACCESS_DENIED"
  | "CREDENTIAL_MISSING"
  | "SOURCE_AUTH_FAILED"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_RATE_LIMITED"
  | "SOURCE_ABORTED"
  | "SOURCE_REQUEST_FAILED"
  | "SOURCE_VERSION_CHANGED"
  | "SOURCE_RESPONSE_TOO_LARGE"
  | "SOURCE_INVALID_RESPONSE"
  | "IMPORT_NOT_FOUND"
  | "RUN_NOT_FOUND"
  | "ANALYSIS_FAILED"
  | "ANALYSIS_TOO_LARGE"
  | "UNSUPPORTED_PROJECT"
  | "IR_NOT_FOUND"
  | "GENERATION_BLOCKED"
  | "GENERATION_FAILED"
  | "BUILD_TOOL_NOT_FOUND"
  | "BUILD_SNAPSHOT_TOO_LARGE"
  | "BUILD_FAILED"
  | "VALIDATION_CANCELLED"
  | "DEVICE_VALIDATION_FAILED"
  | "PREVIEW_NOT_FOUND"
  | "PREVIEW_CONFLICT"
  | "PATCH_CONFLICT"
  | "PATCH_STALE"
  | "APPLY_TOKEN_INVALID"
  | "APPLY_BLOCKED"
  | "APPLY_FAILED"
  | "APPLY_RECOVERY_REQUIRED"
  | "INTERNAL_ERROR";

export type DesignToHarmonyErrorStage = "source" | "import" | "analyze" | "project" | "plan" | "generate" | "preview" | "review" | "apply" | "build" | "device" | "visual" | "sync" | "store";

export class DesignToHarmonyError extends Error {
  readonly code: DesignToHarmonyErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly stage?: DesignToHarmonyErrorStage;

  constructor(
    code: DesignToHarmonyErrorCode,
    message: string,
    options: { status?: number; retryable?: boolean; details?: Record<string, unknown>; stage?: DesignToHarmonyErrorStage; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "DesignToHarmonyError";
    this.code = code;
    this.status = options.status ?? 500;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
    this.stage = options.stage;
  }

  toJSON(): { code: DesignToHarmonyErrorCode; message: string; retryable: boolean; stage?: DesignToHarmonyErrorStage; details?: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.stage ? { stage: this.stage } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function asDesignToHarmonyError(error: unknown): DesignToHarmonyError {
  if (error instanceof DesignToHarmonyError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new DesignToHarmonyError("SOURCE_ABORTED", "Design import was cancelled", {
      status: 499,
      retryable: true,
      cause: error,
    });
  }
  return new DesignToHarmonyError("INTERNAL_ERROR", "Design to Harmony operation failed", {
    status: 500,
    cause: error,
  });
}
