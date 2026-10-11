export function parseScreenState(output: string) {
  const value = (key: string) => new RegExp(`^\\s*(?:\\*\\s*)?${key}\\s+(true|false|\\d+)\\b`, 'im').exec(output)?.[1];
  const on = value('screenState'), interactive = value('interactiveState'), locked = value('screenLocked');
  return { awake: on === 'true' && interactive === '2', locked: locked === 'true' ? true : locked === 'false' ? false : undefined };
}
