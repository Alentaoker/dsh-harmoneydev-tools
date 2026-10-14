"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { UiThemePackId } from "../lib/ui-theme-packs.ts";
import {
  isDarkTheme,
  isTheme,
  LEGACY_THEME_STORAGE_KEY,
  parseStoredTheme,
  readStoredThemePreference,
  serializeThemePreference,
  THEME_PRESETS,
  THEME_STORAGE_KEY,
  type Theme,
} from "../lib/theme-preferences.ts";

export {
  isDarkTheme,
  isTheme,
  LEGACY_THEME_STORAGE_KEY,
  parseStoredTheme,
  readStoredThemePreference,
  serializeThemePreference,
  THEME_INITIALIZATION_SCRIPT,
  THEME_PRESETS,
  THEME_STORAGE_KEY,
} from "../lib/theme-preferences.ts";
export type { Theme, ThemePreset } from "../lib/theme-preferences.ts";

/** Static CSS that a theme pack injects only while that theme is active
    (docs/PIORA_UI_STYLE_SPEC.md §2.6 / task T-02 S8 — no unconditional import). */
const THEME_PACK_STYLESHEETS: Partial<Record<UiThemePackId, string>> = {
  "codex-dream-skin": "/themes/codex-dream-skin/skin.css",
};

const listeners = new Set<() => void>();
let storageListenerAttached = false;

function subscribe(cb: () => void): () => void {
  if (!storageListenerAttached && typeof window !== "undefined") {
    storageListenerAttached = true;
    window.addEventListener("storage", (event) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const next = parseStoredTheme(event.newValue);
      if (next && next !== getSnapshot()) applyTheme(next, false);
    });
  }
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): Theme {
  if (typeof document === "undefined") return "light";
  const theme = document.documentElement.dataset.theme;
  if (isTheme(theme)) return theme;
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function getServerSnapshot(): Theme {
  return "light";
}

function applyTheme(theme: Theme, persist = true): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle("dark", isDarkTheme(theme));
  root.style.colorScheme = isDarkTheme(theme) ? "dark" : "light";

  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, serializeThemePreference(theme));
      // Keep older Pi Web versions usable. Custom dark presets degrade to dark.
      localStorage.setItem(LEGACY_THEME_STORAGE_KEY, isDarkTheme(theme) ? "dark" : "light");
    } catch {
      // Ignore storage errors (private mode, quota, disabled storage, etc.).
    }
  }

  listeners.forEach((cb) => cb());
}

export type ThemeChangeOrigin = { x: number; y: number };

function transitionToTheme(theme: Theme, origin?: ThemeChangeOrigin, appearanceAction?: () => void): void {
  if (theme === getSnapshot()) {
    appearanceAction?.();
    return;
  }

  const commit = () => {
    appearanceAction?.();
    applyTheme(theme);
  };

  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const supportsViewTransition = typeof document.startViewTransition === "function";

  if (!supportsViewTransition || reduceMotion) {
    commit();
    return;
  }

  const x = origin?.x ?? window.innerWidth / 2;
  const y = origin?.y ?? window.innerHeight / 2;
  const endRadius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y),
  );

  const transition = document.startViewTransition(commit);
  transition.ready
    .then(() => {
      document.documentElement.animate(
        {
          clipPath: [
            `circle(0px at ${x}px ${y}px)`,
            `circle(${endRadius}px at ${x}px ${y}px)`,
          ],
        },
        {
          duration: 450,
          easing: "cubic-bezier(0.22, 0.61, 0.36, 1)",
          pseudoElement: "::view-transition-new(root)",
        },
      );
    })
    .catch(() => {
      // A cancelled transition has already applied the requested theme.
    });
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Recover from a cached or older document bootstrap as well as the normal
  // pre-hydration initializer. This keeps the persisted preference authoritative.
  useEffect(() => {
    try {
      const stored = readStoredThemePreference(localStorage);
      if (stored && stored !== getSnapshot()) applyTheme(stored, false);
    } catch {
      // Storage can be unavailable in private or restricted browser contexts.
    }
  }, []);

  // Load the active theme pack's stylesheet on demand and unload it when the
  // theme changes, so non-pack themes never ship the pack's CSS (T-02 S8).
  useEffect(() => {
    const preset = THEME_PRESETS.find(({ id }) => id === theme);
    const href = preset?.packId ? THEME_PACK_STYLESHEETS[preset.packId] : undefined;
    if (!preset || !preset.packId || !href) return;

    let link = document.head.querySelector<HTMLLinkElement>(
      `link[data-theme-pack="${preset.packId}"]`,
    );
    if (!link) {
      link = document.createElement("link");
      link.rel = "stylesheet";
      link.dataset.themePack = preset.packId;
      document.head.appendChild(link);
    }
    link.href = href;

    return () => {
      const current = document.head.querySelector<HTMLLinkElement>(
        `link[data-theme-pack="${preset.packId}"]`,
      );
      current?.remove();
    };
  }, [theme]);

  const setTheme = useCallback((next: Theme, origin?: ThemeChangeOrigin) => {
    transitionToTheme(next, origin);
  }, []);

  const setThemeWithAction = useCallback((next: Theme, action: () => void, origin?: ThemeChangeOrigin) => {
    transitionToTheme(next, origin, action);
  }, []);

  const toggleTheme = useCallback((origin?: ThemeChangeOrigin) => {
    transitionToTheme(isDarkTheme(getSnapshot()) ? "light" : "dark", origin);
  }, []);

  return {
    theme,
    themes: THEME_PRESETS,
    setTheme,
    setThemeWithAction,
    toggleTheme,
    isDark: isDarkTheme(theme),
  };
}
