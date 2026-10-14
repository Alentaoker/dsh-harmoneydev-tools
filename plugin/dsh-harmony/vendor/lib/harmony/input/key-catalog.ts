/** OpenHarmony Input Kit KeyCode, never Android key codes or arbitrary model integers.
 * https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/reference/apis-input-kit/js-apis-keycode.md
 */
export const physicalKeys = { power: 18, volume_up: 16, volume_down: 17 } as const;
export type PhysicalKey = keyof typeof physicalKeys;
export function physicalKeyCode(key: PhysicalKey): number {
  if (!Object.prototype.hasOwnProperty.call(physicalKeys, key)) throw new Error("Unsupported physical key");
  return physicalKeys[key];
}
