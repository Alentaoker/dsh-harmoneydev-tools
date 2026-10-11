import { HarmonyError, asHarmonyError } from "../errors";

/** The device command contains its own bounded UP; cancellation additionally attempts UP. */
export async function runBoundedHold(options: {
  durationMs: number; minMs: number; maxMs: number; signal?: AbortSignal;
  dispatch(signal?: AbortSignal): Promise<void>; release(): Promise<void>;
}): Promise<{ cleanup: "complete" }> {
  if (!Number.isInteger(options.durationMs) || options.durationMs < options.minMs || options.durationMs > options.maxMs) {
    throw new HarmonyError("INVALID_ARGUMENT", `Hold duration must be within the calibrated range ${options.minMs}–${options.maxMs} ms`, { details: { dispatchState: "not-sent" } });
  }
  if (options.signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "Hold cancelled before dispatch", { details: { dispatchState: "not-sent" } });
  try { await options.dispatch(options.signal); return { cleanup: "complete" }; }
  catch (error) {
    const original = asHarmonyError(error);
    try { await options.release(); }
    catch { throw new HarmonyError(original.code, "Hold interrupted and release could not be confirmed; inspect the device manually", { details: { dispatchState: "unknown", cleanup: "uncertain" } }); }
    throw new HarmonyError(original.code, original.message, { details: { ...original.details, dispatchState: "unknown", cleanup: "complete" } });
  }
}
