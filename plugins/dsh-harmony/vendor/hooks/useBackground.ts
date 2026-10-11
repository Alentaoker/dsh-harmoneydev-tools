"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  BACKGROUND_PREFERENCE_STORAGE_KEY,
  BACKGROUND_PRESETS,
  DEFAULT_BACKGROUND_PREFERENCE,
  getBackgroundPreset,
  parseStoredBackgroundPreference,
  serializeBackgroundPreference,
  type BackgroundPreference,
} from "@/lib/backgrounds";
import {
  BackgroundStorageError,
  deleteCustomBackground,
  readCustomBackground,
  saveCustomBackground,
  validateCustomBackgroundFile,
  type BackgroundStorageErrorCode,
  type StoredCustomBackground,
} from "@/lib/background-storage";

const CUSTOM_BACKGROUND_FALLBACK =
  "radial-gradient(circle at 78% 20%, rgba(96, 165, 250, 0.24), transparent 28%), linear-gradient(140deg, #172033, #24324a)";

export interface BackgroundState {
  preference: BackgroundPreference;
  hydrated: boolean;
  busy: boolean;
  hasStoredCustom: boolean;
  customName: string | null;
  error: BackgroundStorageErrorCode | null;
}

const SERVER_STATE: BackgroundState = Object.freeze({
  preference: { ...DEFAULT_BACKGROUND_PREFERENCE },
  hydrated: false,
  busy: false,
  hasStoredCustom: false,
  customName: null,
  error: null,
});

let state: BackgroundState = SERVER_STATE;
let storedCustom: StoredCustomBackground | null = null;
let customObjectUrl: string | null = null;
let hydratePromise: Promise<void> | null = null;
let operationRevision = 0;
let storageListenerAttached = false;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

function setState(next: BackgroundState): void {
  state = next;
  applyBackgroundToDocument(next.preference);
  emit();
}

function escapeCssUrl(value: string): string {
  return value.replace(/(["\\\n\r\f])/g, "\\$1");
}

function applyBackgroundToDocument(preference: BackgroundPreference): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const preset = preference.source === "builtin" ? getBackgroundPreset(preference.presetId) : undefined;
  const customAvailable = preference.source === "custom" && Boolean(customObjectUrl);
  const active = Boolean(preset) || customAvailable;

  if (!active) {
    delete root.dataset.appBackgroundActive;
    delete root.dataset.appBackgroundSource;
    delete root.dataset.appBackgroundPreset;
    root.style.removeProperty("--app-background-image");
    root.style.removeProperty("--app-background-fallback");
    root.style.removeProperty("--app-background-overlay");
    root.style.removeProperty("--app-background-sidebar-overlay");
    root.style.removeProperty("--app-background-file-panel-overlay");
    root.style.removeProperty("--app-background-blur");
    return;
  }

  root.dataset.appBackgroundActive = "true";
  root.dataset.appBackgroundSource = preference.source;
  if (preset) root.dataset.appBackgroundPreset = preset.id;
  else delete root.dataset.appBackgroundPreset;

  // Planned slots intentionally use only their color-study fallback. Changing
  // the manifest status to "available" activates the fixed local asset path.
  const imageUrl = preset?.artworkStatus === "available"
    ? preset.asset
    : customAvailable
      ? customObjectUrl
      : null;
  root.style.setProperty(
    "--app-background-image",
    imageUrl ? `url("${escapeCssUrl(imageUrl)}")` : "none",
  );
  root.style.setProperty("--app-background-fallback", preset?.fallback ?? CUSTOM_BACKGROUND_FALLBACK);
  root.style.setProperty("--app-background-overlay", `${preference.overlay}%`);
  root.style.setProperty("--app-background-sidebar-overlay", `${preference.sidebarOverlay}%`);
  root.style.setProperty("--app-background-file-panel-overlay", `${preference.filePanelOverlay}%`);
  root.style.setProperty("--app-background-blur", `${preference.blur}px`);
}

function readPreference(): BackgroundPreference {
  try {
    return parseStoredBackgroundPreference(localStorage.getItem(BACKGROUND_PREFERENCE_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_BACKGROUND_PREFERENCE };
  }
}

function persistPreference(preference: BackgroundPreference): void {
  try {
    localStorage.setItem(BACKGROUND_PREFERENCE_STORAGE_KEY, serializeBackgroundPreference(preference));
  } catch {
    // Preferences still apply for the current browser session.
  }
}

function replaceCustomObjectUrl(record: StoredCustomBackground | null): void {
  if (customObjectUrl) URL.revokeObjectURL(customObjectUrl);
  customObjectUrl = record ? URL.createObjectURL(record.blob) : null;
}

async function hydrateBackground(force = false): Promise<void> {
  if (hydratePromise && !force) return hydratePromise;
  const startingRevision = operationRevision;
  const task = (async () => {
    const preference = readPreference();
    const custom = await readCustomBackground();
    if (startingRevision !== operationRevision) return;

    storedCustom = custom;
    replaceCustomObjectUrl(preference.source === "custom" ? custom : null);
    const missingCustom = preference.source === "custom" && !custom;
    const effectivePreference = missingCustom
      ? { ...preference, source: "none" as const, presetId: null }
      : preference;
    if (missingCustom) persistPreference(effectivePreference);
    setState({
      preference: effectivePreference,
      hydrated: true,
      busy: false,
      hasStoredCustom: Boolean(custom),
      customName: custom?.name ?? null,
      error: missingCustom ? "missing-custom" : null,
    });
  })().catch(() => {
    if (startingRevision !== operationRevision) return;
    setState({
      ...state,
      preference: readPreference(),
      hydrated: true,
      busy: false,
      error: "storage-unavailable",
    });
  }).finally(() => {
    if (hydratePromise === task) hydratePromise = null;
  });
  hydratePromise = task;
  return task;
}

function attachStorageListener(): void {
  if (storageListenerAttached || typeof window === "undefined") return;
  storageListenerAttached = true;
  window.addEventListener("storage", (event) => {
    if (event.key === BACKGROUND_PREFERENCE_STORAGE_KEY) void hydrateBackground(true);
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  attachStorageListener();
  return () => listeners.delete(listener);
}

function getSnapshot(): BackgroundState {
  return state;
}

function getServerSnapshot(): BackgroundState {
  return SERVER_STATE;
}

function commitPreference(preference: BackgroundPreference, error: BackgroundStorageErrorCode | null = null): void {
  operationRevision += 1;
  persistPreference(preference);
  setState({ ...state, preference, hydrated: true, busy: false, error });
}

function errorCode(error: unknown): BackgroundStorageErrorCode {
  return error instanceof BackgroundStorageError ? error.code : "storage-unavailable";
}

function activateBackground(
  preference: BackgroundPreference,
  source: "builtin" | "custom",
  presetId: string | null,
): BackgroundPreference {
  return {
    ...preference,
    source,
    presetId,
    ...(preference.source === "none" ? {
      sidebarOverlay: DEFAULT_BACKGROUND_PREFERENCE.sidebarOverlay,
      filePanelOverlay: DEFAULT_BACKGROUND_PREFERENCE.filePanelOverlay,
    } : {}),
  };
}

export function useBackground() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    void hydrateBackground();
  }, []);

  const setNone = useCallback(() => {
    replaceCustomObjectUrl(null);
    commitPreference({ ...snapshot.preference, source: "none", presetId: null });
  }, [snapshot.preference]);

  const setBuiltin = useCallback((presetId: string) => {
    if (!getBackgroundPreset(presetId)) return;
    replaceCustomObjectUrl(null);
    commitPreference(activateBackground(snapshot.preference, "builtin", presetId));
  }, [snapshot.preference]);

  const applyBuiltinPreset = useCallback((
    presetId: string,
    options: {
      overlay?: number;
      blur?: number;
      sidebarOverlay?: number;
      filePanelOverlay?: number;
    } = {},
  ) => {
    if (!getBackgroundPreset(presetId)) return;
    replaceCustomObjectUrl(null);
    commitPreference({
      ...activateBackground(snapshot.preference, "builtin", presetId),
      overlay: Math.min(90, Math.max(0, Math.round(options.overlay ?? snapshot.preference.overlay))),
      blur: Math.min(24, Math.max(0, Math.round(options.blur ?? snapshot.preference.blur))),
      sidebarOverlay: Math.min(90, Math.max(0, Math.round(options.sidebarOverlay ?? snapshot.preference.sidebarOverlay))),
      filePanelOverlay: Math.min(90, Math.max(0, Math.round(options.filePanelOverlay ?? snapshot.preference.filePanelOverlay))),
    });
  }, [snapshot.preference]);

  const selectStoredCustom = useCallback(async (options: {
    overlay?: number;
    blur?: number;
    sidebarOverlay?: number;
    filePanelOverlay?: number;
  } = {}) => {
    const revision = ++operationRevision;
    setState({ ...state, busy: true, error: null });
    try {
      const record = storedCustom ?? await readCustomBackground();
      if (!record) throw new BackgroundStorageError("missing-custom", "No saved custom background exists");
      if (revision !== operationRevision) return;
      storedCustom = record;
      replaceCustomObjectUrl(record);
      const basePreference = activateBackground(state.preference, "custom", null);
      const preference = {
        ...basePreference,
        overlay: Math.min(90, Math.max(0, Math.round(options.overlay ?? basePreference.overlay))),
        blur: Math.min(24, Math.max(0, Math.round(options.blur ?? basePreference.blur))),
        sidebarOverlay: Math.min(90, Math.max(0, Math.round(options.sidebarOverlay ?? basePreference.sidebarOverlay))),
        filePanelOverlay: Math.min(90, Math.max(0, Math.round(options.filePanelOverlay ?? basePreference.filePanelOverlay))),
      };
      persistPreference(preference);
      setState({
        preference,
        hydrated: true,
        busy: false,
        hasStoredCustom: true,
        customName: record.name,
        error: null,
      });
    } catch (error) {
      if (revision !== operationRevision) return;
      setState({ ...state, busy: false, error: errorCode(error) });
    }
  }, []);

  const uploadCustom = useCallback(async (file: File) => {
    const revision = ++operationRevision;
    setState({ ...state, busy: true, error: null });
    try {
      const validated = await validateCustomBackgroundFile(file);
      const record: StoredCustomBackground = {
        blob: validated.blob,
        mime: validated.mime,
        name: file.name.slice(0, 160) || "Local background",
        updatedAt: Date.now(),
      };
      await saveCustomBackground(record);
      if (revision !== operationRevision) return;
      storedCustom = record;
      replaceCustomObjectUrl(record);
      const preference = activateBackground(state.preference, "custom", null);
      persistPreference(preference);
      setState({
        preference,
        hydrated: true,
        busy: false,
        hasStoredCustom: true,
        customName: record.name,
        error: null,
      });
    } catch (error) {
      if (revision !== operationRevision) return;
      setState({ ...state, busy: false, error: errorCode(error) });
    }
  }, []);

  const setOverlay = useCallback((overlay: number) => {
    commitPreference({
      ...snapshot.preference,
      overlay: Math.min(90, Math.max(0, Math.round(overlay))),
    });
  }, [snapshot.preference]);

  const setSidebarOverlay = useCallback((sidebarOverlay: number) => {
    commitPreference({
      ...snapshot.preference,
      sidebarOverlay: Math.min(90, Math.max(0, Math.round(sidebarOverlay))),
    });
  }, [snapshot.preference]);

  const setFilePanelOverlay = useCallback((filePanelOverlay: number) => {
    commitPreference({
      ...snapshot.preference,
      filePanelOverlay: Math.min(90, Math.max(0, Math.round(filePanelOverlay))),
    });
  }, [snapshot.preference]);

  const setBlur = useCallback((blur: number) => {
    commitPreference({
      ...snapshot.preference,
      blur: Math.min(24, Math.max(0, Math.round(blur))),
    });
  }, [snapshot.preference]);

  const reset = useCallback(async () => {
    operationRevision += 1;
    storedCustom = null;
    replaceCustomObjectUrl(null);
    try {
      localStorage.removeItem(BACKGROUND_PREFERENCE_STORAGE_KEY);
    } catch {
      // Reset still applies in memory.
    }
    setState({ ...SERVER_STATE, hydrated: true });
    await deleteCustomBackground();
  }, []);

  return {
    ...snapshot,
    customPreviewUrl: customObjectUrl,
    presets: BACKGROUND_PRESETS,
    setNone,
    setBuiltin,
    applyBuiltinPreset,
    selectStoredCustom,
    uploadCustom,
    setOverlay,
    setSidebarOverlay,
    setFilePanelOverlay,
    setBlur,
    reset,
  };
}
