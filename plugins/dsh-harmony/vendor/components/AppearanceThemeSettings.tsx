"use client";

import { useState } from "react";
import { useTheme, type Theme, type ThemePreset } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";
import { AliIcon } from "./AliIcon";
import { AppearanceLooks } from "./AppearanceLooks";
import styles from "./AppearanceSettings.module.css";

export function AppearanceThemeSettings() {
  const { t } = useI18n();
  const { theme, themes, setTheme } = useTheme();
  const [moreThemesOpen, setMoreThemesOpen] = useState(false);
  return <div className={styles.themeContent}>
    <div data-settings-id="appearance.looks"><AppearanceLooks /></div>
    <section data-settings-id="appearance.theme" aria-labelledby="settings-appearance-theme" className={styles.themeSection}>
      <h3 id="settings-appearance-theme">{t("appearance.theme")}</h3>
      <p>{t("appearance.themeHint")}</p>
      <div role="radiogroup" aria-label={t("appearance.theme")} className={styles.themeGrid}>
        {themes.filter(({ id }) => id === "light" || id === "dark").map(preset => <ThemeOption key={preset.id} preset={preset} theme={theme} onSelect={setTheme} translate={t} />)}
      </div>
      <button type="button" className={styles.moreThemes} aria-expanded={moreThemesOpen} onClick={() => setMoreThemesOpen(open => !open)}>
        <AliIcon name={moreThemesOpen ? "arrowdown" : "arrowright"} size={12} />
        <span>{t("theme.more")}</span><span>{themes.length - 2}</span>
      </button>
      {moreThemesOpen && <div role="radiogroup" aria-label={t("theme.more")} className={styles.themeGrid}>
        {themes.filter(({ id }) => id !== "light" && id !== "dark").map(preset => <ThemeOption key={preset.id} preset={preset} theme={theme} onSelect={setTheme} translate={t} />)}
      </div>}
    </section>
  </div>;
}

interface ThemeOptionProps {
  preset: ThemePreset;
  theme: Theme;
  onSelect: (next: Theme, origin?: { x: number; y: number }) => void;
  translate: (key: string, params?: Record<string, string | number>) => string;
}

function ThemeOption({ preset, theme, onSelect, translate }: ThemeOptionProps) {
  const selected = theme === preset.id;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className="theme-menu-option"
      data-theme-id={preset.id}
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        onSelect(preset.id, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      }}
      style={{
        minWidth: 0,
        padding: 8,
        display: "flex",
        alignItems: "center",
        gap: 8,
        border: selected ? "1px solid var(--accent)" : "1px solid var(--border)",
        borderRadius: "var(--radius-control)",
        background: selected ? "var(--bg-selected)" : "var(--bg)",
        color: "var(--text)",
        cursor: "pointer",
        textAlign: "left",
        fontSize: "var(--text-xs)",
        transition: "border-color 0.12s, background 0.12s",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: "relative",
          width: 28,
          height: 28,
          flex: "0 0 28px",
          overflow: "hidden",
          borderRadius: "var(--radius-small)",
          background: preset.preview.background,
          border: "1px solid color-mix(in srgb, var(--border) 72%, var(--text-dim))",
        }}
      >
        <span style={{ position: "absolute", right: 4, bottom: 4, width: 8, height: 8, borderRadius: "50%", background: preset.preview.accent }} />
      </span>
      <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {translate(`theme.${preset.id}.name`)}
      </span>
      {selected ? (
        <AliIcon name="check" size={13} style={{ color: "var(--accent)" }} />
      ) : null}
    </button>
  );
}
