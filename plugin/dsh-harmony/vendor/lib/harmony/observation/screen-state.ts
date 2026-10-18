export interface HarmonyScreenState {
  /** Screen is powered on and the window manager reports an interactive session. */
  awake: boolean;
  /** `true` locked, `false` unlocked, `undefined` when the device did not answer. */
  locked?: boolean;
}

function field(output: string, key: string) {
  return new RegExp(`^\\s*(?:\\*\\s*)?${key}\\s+(true|false|\\d+)\\b`, 'im').exec(output)?.[1];
}

export function parseScreenState(output: string) {
  const on = field(output, 'screenState'), interactive = field(output, 'interactiveState'), locked = field(output, 'screenLocked');
  return { awake: on === 'true' && interactive === '2', locked: locked === 'true' ? true : locked === 'false' ? false : undefined };
}

export function parseHarmonyScreenState(output: string): HarmonyScreenState {
  const parsed = parseScreenState(output);
  return { awake: parsed.awake, ...(parsed.locked === undefined ? {} : { locked: parsed.locked }) };
}

/** Only a confirmed unlocked and awake screen can start a real video stream. */
export function canStartVideoStream(state: HarmonyScreenState | undefined): boolean {
  return state?.awake === true && state.locked === false;
}

/**
 * A stable key for change detection. Unknown lock state is deliberately its own
 * value so an unreadable device never looks like an unlocked one.
 */
export function screenStateSignature(state: HarmonyScreenState | undefined): string {
  if (!state) return 'unknown';
  return `${state.awake ? 'awake' : 'asleep'}:${state.locked === true ? 'locked' : state.locked === false ? 'unlocked' : 'unknown'}`;
}
