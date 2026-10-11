"use client";

import { useState } from "react";
import { useBackground } from "@/hooks/useBackground";
import { useFontPreferences } from "@/hooks/useFontPreferences";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { useInterfaceTransparency } from "@/hooks/useInterfaceTransparency";
import { AliIcon } from "./AliIcon";

export function AppearanceResetButton({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const { setTheme } = useTheme();
  const { reset: resetFont } = useFontPreferences();
  const { reset: resetTransparency } = useInterfaceTransparency();
  const { reset: resetBackground, busy } = useBackground();
  const [resetting, setResetting] = useState(false);
  const [complete, setComplete] = useState(false);

  const resetAppearance = async () => {
    if (resetting || busy) return;
    setResetting(true);
    setComplete(false);
    setTheme("light");
    resetFont();
    resetTransparency();
    try {
      await resetBackground();
      setComplete(true);
      window.setTimeout(() => setComplete(false), 2200);
    } finally {
      setResetting(false);
    }
  };

  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 9, marginTop: compact ? 0 : 12 }}>
      <button
        type="button"
        data-appearance-reset
        disabled={resetting || busy}
        onClick={() => void resetAppearance()}
        style={{
          minHeight: 34,
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          padding: "6px 11px",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-control)",
          background: "var(--bg)",
          color: "var(--text)",
          cursor: resetting || busy ? "wait" : "pointer",
          font: "inherit",
          fontSize: "var(--text-xs)",
          fontWeight: 650,
        }}
      >
        <AliIcon name="reload" size={13} />
        {resetting ? t("appearance.resetting") : t(compact ? "appearance.transparency.reset" : "appearance.resetAll")}
      </button>
      <span aria-live="polite" style={{ color: complete ? "var(--status-ready)" : "var(--text-dim)", fontSize: "var(--text-xs)" }}>
        {complete ? t("appearance.resetComplete") : compact ? "" : t("appearance.resetHint")}
      </span>
    </div>
  );
}
