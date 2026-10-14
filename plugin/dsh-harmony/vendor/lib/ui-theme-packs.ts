/**
 * UI theme packs are deliberately separate from Pi terminal themes. A pack
 * can describe attribution and its renderer entry point without granting
 * arbitrary plugin code access to the Electron bridge.
 */
export type UiThemePackId = "codex-dream-skin";

export interface UiThemePackDescriptor {
  id: UiThemePackId;
  theme: "dream";
  name: string;
  version: string;
  source: string;
  license: "MIT";
  entry: "builtin";
  cssSource: string;
  artwork: "none";
}

export const UI_THEME_PACKS: readonly UiThemePackDescriptor[] = [
  {
    id: "codex-dream-skin",
    theme: "dream",
    name: "Dream Skin",
    version: "1.0.0",
    source: "https://github.com/Fei-Away/Codex-Dream-Skin",
    license: "MIT",
    entry: "builtin",
    cssSource: "/themes/codex-dream-skin/skin.css",
    artwork: "none",
  },
] as const;

export function getUiThemePack(id: UiThemePackId): UiThemePackDescriptor | undefined {
  return UI_THEME_PACKS.find((pack) => pack.id === id);
}
