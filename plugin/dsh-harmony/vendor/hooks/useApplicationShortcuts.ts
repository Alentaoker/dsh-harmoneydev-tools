"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  KEYBOARD_SHORTCUT_STORAGE_KEY,
  findShortcutConflict,
  isReservedShortcutBinding,
  parseShortcutOverrides,
  resolveShortcutBindings,
  serializeShortcutOverrides,
  type ApplicationShortcutId,
  type ShortcutOverrides,
} from "@/lib/keyboard-shortcuts";

const SHORTCUT_CHANGE_EVENT = "piora:keyboard-shortcuts-changed";

function readOverrides(): ShortcutOverrides {
  if (typeof window === "undefined") return {};
  return parseShortcutOverrides(window.localStorage.getItem(KEYBOARD_SHORTCUT_STORAGE_KEY));
}

export function useApplicationShortcuts() {
  const [overrides, setOverrides] = useState<ShortcutOverrides>(readOverrides);

  useEffect(() => {
    const refresh = () => setOverrides(readOverrides());
    window.addEventListener(SHORTCUT_CHANGE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(SHORTCUT_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const bindings = useMemo(() => resolveShortcutBindings(overrides), [overrides]);
  const save = useCallback((next: ShortcutOverrides) => {
    window.localStorage.setItem(KEYBOARD_SHORTCUT_STORAGE_KEY, serializeShortcutOverrides(next));
    setOverrides(next);
    window.dispatchEvent(new Event(SHORTCUT_CHANGE_EVENT));
  }, []);

  const setBinding = useCallback((id: ApplicationShortcutId, binding: string | null): { ok: true } | { ok: false; conflict: ApplicationShortcutId } | { ok: false; reserved: true } => {
    if (isReservedShortcutBinding(binding)) return { ok: false, reserved: true };
    const conflict = findShortcutConflict(bindings, id, binding);
    if (conflict) return { ok: false, conflict };
    save({ ...overrides, [id]: binding });
    return { ok: true };
  }, [bindings, overrides, save]);

  const resetBinding = useCallback((id: ApplicationShortcutId) => {
    const next = { ...overrides };
    delete next[id];
    save(next);
  }, [overrides, save]);

  const resetAll = useCallback(() => save({}), [save]);

  return { bindings, overrides, setBinding, resetBinding, resetAll };
}
