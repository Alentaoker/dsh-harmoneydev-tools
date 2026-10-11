import type { UiThemePackId } from "./ui-theme-packs.ts";

export type Theme =
  | "light"
  | "dark"
  | "starlight"
  | "ivory"
  | "doodle"
  | "fortune"
  | "nordic"
  | "sakura"
  | "kitty"
  | "cloud-bear"
  | "anime-sky"
  | "anime-sakura"
  | "anime-magic"
  | "anime-neon"
  | "anime-star"
  | "midnight"
  | "forest"
  | "cyber"
  | "ember"
  | "dream";

export interface ThemePreset {
  id: Theme;
  isDark: boolean;
  packId?: UiThemePackId;
  preview: {
    background: string;
    accent: string;
  };
}

export const THEME_PRESETS: readonly ThemePreset[] = [
  { id: "light", isDark: false, preview: { background: "#fffdfc", accent: "#3569d4" } },
  { id: "dark", isDark: true, preview: { background: "#1a1a1a", accent: "#60a5fa" } },
  { id: "starlight", isDark: false, preview: { background: "#f3f2ff", accent: "#7857e8" } },
  { id: "ivory", isDark: false, preview: { background: "#f8f5e9", accent: "#78834f" } },
  { id: "doodle", isDark: false, preview: { background: "#fff9e9", accent: "#0e9f8f" } },
  { id: "fortune", isDark: false, preview: { background: "#fff5dc", accent: "#b92c25" } },
  { id: "nordic", isDark: false, preview: { background: "#f5f9fc", accent: "#146c82" } },
  { id: "sakura", isDark: false, preview: { background: "#fff7fa", accent: "#a63d68" } },
  { id: "kitty", isDark: false, preview: { background: "#fff5f8", accent: "#e65383" } },
  { id: "cloud-bear", isDark: false, preview: { background: "#f3faff", accent: "#3f8ee8" } },
  { id: "anime-sky", isDark: false, preview: { background: "#f3faff", accent: "#17639a" } },
  { id: "anime-sakura", isDark: false, preview: { background: "#fff6f3", accent: "#a83c5e" } },
  { id: "anime-magic", isDark: true, preview: { background: "#0d1029", accent: "#a994ff" } },
  { id: "anime-neon", isDark: true, preview: { background: "#061326", accent: "#45d9ff" } },
  { id: "anime-star", isDark: true, preview: { background: "#07131e", accent: "#4cb7e8" } },
  { id: "midnight", isDark: true, preview: { background: "#0b1020", accent: "#8b9dff" } },
  { id: "forest", isDark: true, preview: { background: "#101914", accent: "#6fcf97" } },
  { id: "cyber", isDark: true, preview: { background: "#07191c", accent: "#4fd1c5" } },
  { id: "ember", isDark: true, preview: { background: "#1b1110", accent: "#ff9a62" } },
  { id: "dream", isDark: true, packId: "codex-dream-skin", preview: { background: "#111318", accent: "#8da397" } },
] as const;

export const THEME_STORAGE_KEY = "pi-theme:v1";
export const LEGACY_THEME_STORAGE_KEY = "pi-theme";

const THEME_IDS = new Set<Theme>(THEME_PRESETS.map(({ id }) => id));
const DARK_THEME_IDS = new Set<Theme>(
  THEME_PRESETS.filter(({ isDark }) => isDark).map(({ id }) => id),
);

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && THEME_IDS.has(value as Theme);
}

export function isDarkTheme(theme: Theme): boolean {
  return DARK_THEME_IDS.has(theme);
}

/** Accepts both the versioned payload and the old plain `pi-theme` value. */
export function parseStoredTheme(value: string | null): Theme | null {
  if (!value) return null;
  if (isTheme(value)) return value;

  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && "theme" in parsed) {
      const theme = (parsed as { theme?: unknown }).theme;
      return isTheme(theme) ? theme : null;
    }
  } catch {
    // A malformed preference falls back to the legacy key or the light theme.
  }
  return null;
}

export function serializeThemePreference(theme: Theme): string {
  return JSON.stringify({ theme });
}

export function readStoredThemePreference(
  storage: Pick<Storage, "getItem">,
): Theme | null {
  return parseStoredTheme(storage.getItem(THEME_STORAGE_KEY))
    ?? parseStoredTheme(storage.getItem(LEGACY_THEME_STORAGE_KEY));
}

const serializedThemeIds = JSON.stringify(THEME_PRESETS.map(({ id }) => id));
const serializedDarkThemeIds = JSON.stringify(
  THEME_PRESETS.filter(({ isDark }) => isDark).map(({ id }) => id),
);

/** Runs before hydration so a persisted theme never flashes or resets on restart. */
export const THEME_INITIALIZATION_SCRIPT = `(function(){try{var a=${serializedThemeIds},k=${serializedDarkThemeIds},f=function(x){return a.indexOf(x)>-1},p=function(v){if(!v)return null;if(f(v))return v;try{var x=JSON.parse(v);return x&&f(x.theme)?x.theme:null}catch(_){return null}},t=p(localStorage.getItem("${THEME_STORAGE_KEY}"))||p(localStorage.getItem("${LEGACY_THEME_STORAGE_KEY}"))||"light",r=document.documentElement,d=k.indexOf(t)>-1;r.setAttribute("data-theme",t);r.classList.toggle("dark",d);r.style.colorScheme=d?"dark":"light"}catch(_){}})();`;
