"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "./useI18n";
import {
  COMPANION_STORAGE_KEY,
  createDefaultCompanionPreferences,
  parseCompanionPreferences,
  type CompanionPreferences,
} from "@/lib/companion-store";
import type { CompanionRuntimeState } from "@/lib/companion-runtime";
import { mergeCompanionRuntimePreferences } from "@/lib/companion-preference-sync";
import {
  createCompanionRuntimeChannel,
  fetchCompanionRuntimeState,
} from "@/lib/companion-runtime-client";

export function useCompanionPreferences() {
  const { t } = useI18n();
  const defaults = useMemo(() => createDefaultCompanionPreferences([
    { label: t("companion.defaultContinueLabel"), text: t("companion.defaultContinueText") },
    { label: t("companion.defaultTestLabel"), text: t("companion.defaultTestText") },
  ]), [t]);
  const [preferences, setPreferences] = useState<CompanionPreferences>(defaults);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let restored = defaults;
    try {
      restored = parseCompanionPreferences(window.localStorage.getItem(COMPANION_STORAGE_KEY), defaults);
    } catch {
      // Storage may be disabled by browser policy. The companion remains
      // available in memory for the current app session.
    }
    setPreferences(restored);
    setHydrated(true);
  }, [defaults]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(COMPANION_STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      // Keep the feature usable in memory when persistence is unavailable.
    }
  }, [hydrated, preferences]);

  useEffect(() => {
    if (!hydrated) return;
    const controller = new AbortController();
    const applyRuntime = (runtime: CompanionRuntimeState) => {
      setPreferences((current) => mergeCompanionRuntimePreferences(current, runtime));
    };
    const channel = createCompanionRuntimeChannel(applyRuntime);
    void fetchCompanionRuntimeState({ signal: controller.signal }).then(applyRuntime).catch(() => {
      // A later companion broadcast will reconcile transient request failures.
    });
    return () => {
      controller.abort();
      channel?.close();
    };
  }, [hydrated]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== COMPANION_STORAGE_KEY) return;
      setPreferences(parseCompanionPreferences(event.newValue, defaults));
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [defaults]);

  const setOpen = useCallback((open: boolean) => {
    setPreferences((current) => ({ ...current, open }));
  }, []);

  return { preferences, setPreferences, setOpen, hydrated };
}
