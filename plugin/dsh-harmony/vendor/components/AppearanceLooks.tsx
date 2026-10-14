"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useBackground } from "@/hooks/useBackground";
import { useI18n } from "@/hooks/useI18n";
import { isTheme, useTheme, type Theme } from "@/hooks/useTheme";
import { getBackgroundPreset, SUPPORTED_BACKGROUND_MIME_TYPES } from "@/lib/backgrounds";
import { AliIcon } from "./AliIcon";

interface AppearanceLook {
  id: string;
  theme: Theme;
  backgroundId: string | null;
  overlay: number;
  blur: number;
  sidebarOverlay: number;
  filePanelOverlay: number;
  previewOverlay: string;
  previewBackground?: string;
  nameKey: string;
  descriptionKey: string;
}

interface SavedCustomLook {
  schemaVersion: 1;
  name: string;
  theme: Theme;
  overlay: number;
  blur: number;
  sidebarOverlay: number;
  filePanelOverlay: number;
}

const CUSTOM_LOOK_STORAGE_KEY = "pi-appearance:custom-look:v1";

function parseSavedCustomLook(value: string | null): SavedCustomLook | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<SavedCustomLook>;
    if (parsed.schemaVersion !== 1
      || typeof parsed.name !== "string"
      || !parsed.name.trim()
      || !isTheme(parsed.theme)
      || ![parsed.overlay, parsed.blur, parsed.sidebarOverlay, parsed.filePanelOverlay]
        .every((entry) => typeof entry === "number" && Number.isFinite(entry))) return null;
    return {
      schemaVersion: 1,
      name: parsed.name.trim().slice(0, 48),
      theme: parsed.theme,
      overlay: Math.min(90, Math.max(0, Math.round(parsed.overlay as number))),
      blur: Math.min(24, Math.max(0, Math.round(parsed.blur as number))),
      sidebarOverlay: Math.min(90, Math.max(0, Math.round(parsed.sidebarOverlay as number))),
      filePanelOverlay: Math.min(90, Math.max(0, Math.round(parsed.filePanelOverlay as number))),
    };
  } catch {
    return null;
  }
}

const APPEARANCE_LOOKS: readonly AppearanceLook[] = [
  {
    id: "codex",
    theme: "dream",
    backgroundId: null,
    overlay: 58,
    blur: 0,
    sidebarOverlay: 36,
    filePanelOverlay: 42,
    previewOverlay: "transparent",
    previewBackground: "radial-gradient(circle at 72% 0%, rgba(136, 157, 146, 0.16), transparent 43%), linear-gradient(145deg, #111214, #17191c 55%, #101113)",
    nameKey: "appearance.look.codex",
    descriptionKey: "appearance.look.codexDescription",
  },
  {
    id: "starlight",
    theme: "starlight",
    backgroundId: "aurora-glass",
    overlay: 72,
    blur: 0,
    sidebarOverlay: 44,
    filePanelOverlay: 48,
    previewOverlay: "rgba(248, 247, 255, 0.34)",
    nameKey: "appearance.look.starlight",
    descriptionKey: "appearance.look.starlightDescription",
  },
  {
    id: "ivory",
    theme: "ivory",
    backgroundId: "sage-paper",
    overlay: 28,
    blur: 0,
    sidebarOverlay: 24,
    filePanelOverlay: 32,
    previewOverlay: "rgba(251, 249, 240, 0.18)",
    nameKey: "appearance.look.ivory",
    descriptionKey: "appearance.look.ivoryDescription",
  },
  {
    id: "doodle",
    theme: "doodle",
    backgroundId: "playful-doodle",
    overlay: 30,
    blur: 0,
    sidebarOverlay: 26,
    filePanelOverlay: 32,
    previewOverlay: "rgba(255, 250, 240, 0.14)",
    nameKey: "appearance.look.doodle",
    descriptionKey: "appearance.look.doodleDescription",
  },
  {
    id: "fortune",
    theme: "fortune",
    backgroundId: "auspicious-cloud",
    overlay: 24,
    blur: 0,
    sidebarOverlay: 28,
    filePanelOverlay: 34,
    previewOverlay: "rgba(255, 249, 235, 0.12)",
    nameKey: "appearance.look.fortune",
    descriptionKey: "appearance.look.fortuneDescription",
  },
  {
    id: "kitty",
    theme: "kitty",
    backgroundId: "kitty-candy",
    overlay: 20,
    blur: 0,
    sidebarOverlay: 22,
    filePanelOverlay: 28,
    previewOverlay: "rgba(255, 248, 251, 0.1)",
    nameKey: "appearance.look.kitty",
    descriptionKey: "appearance.look.kittyDescription",
  },
  {
    id: "cloud-bear",
    theme: "cloud-bear",
    backgroundId: "cloud-bear",
    overlay: 22,
    blur: 0,
    sidebarOverlay: 24,
    filePanelOverlay: 28,
    previewOverlay: "rgba(246, 252, 255, 0.1)",
    nameKey: "appearance.look.cloudBear",
    descriptionKey: "appearance.look.cloudBearDescription",
  },
  {
    id: "anime-sky",
    theme: "anime-sky",
    backgroundId: "anime-sky-campus",
    overlay: 28,
    blur: 0,
    sidebarOverlay: 30,
    filePanelOverlay: 36,
    previewOverlay: "rgba(244, 251, 255, 0.14)",
    nameKey: "appearance.look.animeSky",
    descriptionKey: "appearance.look.animeSkyDescription",
  },
  {
    id: "anime-sakura",
    theme: "anime-sakura",
    backgroundId: "anime-sakura-train",
    overlay: 28,
    blur: 0,
    sidebarOverlay: 30,
    filePanelOverlay: 36,
    previewOverlay: "rgba(255, 246, 243, 0.14)",
    nameKey: "appearance.look.animeSakura",
    descriptionKey: "appearance.look.animeSakuraDescription",
  },
  {
    id: "anime-magic",
    theme: "anime-magic",
    backgroundId: "anime-magic-library",
    overlay: 52,
    blur: 0,
    sidebarOverlay: 42,
    filePanelOverlay: 48,
    previewOverlay: "rgba(13, 16, 41, 0.34)",
    nameKey: "appearance.look.animeMagic",
    descriptionKey: "appearance.look.animeMagicDescription",
  },
  {
    id: "anime-neon",
    theme: "anime-neon",
    backgroundId: "anime-neon-city",
    overlay: 54,
    blur: 0,
    sidebarOverlay: 44,
    filePanelOverlay: 50,
    previewOverlay: "rgba(6, 19, 38, 0.36)",
    nameKey: "appearance.look.animeNeon",
    descriptionKey: "appearance.look.animeNeonDescription",
  },
  {
    id: "anime-star",
    theme: "anime-star",
    backgroundId: "anime-star-hangar",
    overlay: 54,
    blur: 0,
    sidebarOverlay: 44,
    filePanelOverlay: 50,
    previewOverlay: "rgba(7, 19, 30, 0.36)",
    nameKey: "appearance.look.animeStar",
    descriptionKey: "appearance.look.animeStarDescription",
  },
  {
    id: "nordic",
    theme: "nordic",
    backgroundId: "nordic-ice",
    overlay: 26,
    blur: 0,
    sidebarOverlay: 24,
    filePanelOverlay: 30,
    previewOverlay: "rgba(245, 249, 252, 0.18)",
    nameKey: "appearance.look.nordic",
    descriptionKey: "appearance.look.nordicDescription",
  },
  {
    id: "sakura",
    theme: "sakura",
    backgroundId: "sakura-mist",
    overlay: 24,
    blur: 0,
    sidebarOverlay: 26,
    filePanelOverlay: 32,
    previewOverlay: "rgba(255, 247, 250, 0.14)",
    nameKey: "appearance.look.sakura",
    descriptionKey: "appearance.look.sakuraDescription",
  },
  {
    id: "cyber",
    theme: "cyber",
    backgroundId: "cyber-teal",
    overlay: 58,
    blur: 0,
    sidebarOverlay: 44,
    filePanelOverlay: 50,
    previewOverlay: "rgba(7, 25, 28, 0.42)",
    nameKey: "appearance.look.cyber",
    descriptionKey: "appearance.look.cyberDescription",
  },
  {
    id: "ember",
    theme: "ember",
    backgroundId: "desert-sunset",
    overlay: 58,
    blur: 0,
    sidebarOverlay: 44,
    filePanelOverlay: 50,
    previewOverlay: "rgba(27, 17, 16, 0.42)",
    nameKey: "appearance.look.ember",
    descriptionKey: "appearance.look.emberDescription",
  },
  {
    id: "surreal",
    theme: "midnight",
    backgroundId: "surreal-stillness",
    overlay: 56,
    blur: 0,
    sidebarOverlay: 42,
    filePanelOverlay: 48,
    previewOverlay: "rgba(11, 16, 32, 0.38)",
    nameKey: "appearance.look.surreal",
    descriptionKey: "appearance.look.surrealDescription",
  },
  {
    id: "riso",
    theme: "doodle",
    backgroundId: "riso-garden",
    overlay: 24,
    blur: 0,
    sidebarOverlay: 26,
    filePanelOverlay: 32,
    previewOverlay: "rgba(255, 250, 240, 0.12)",
    nameKey: "appearance.look.riso",
    descriptionKey: "appearance.look.risoDescription",
  },
  {
    id: "liquid-chrome",
    theme: "midnight",
    backgroundId: "liquid-chrome",
    overlay: 54,
    blur: 0,
    sidebarOverlay: 44,
    filePanelOverlay: 50,
    previewOverlay: "rgba(11, 16, 32, 0.38)",
    nameKey: "appearance.look.liquidChrome",
    descriptionKey: "appearance.look.liquidChromeDescription",
  },
  {
    id: "soft-clay",
    theme: "ivory",
    backgroundId: "soft-clay",
    overlay: 24,
    blur: 0,
    sidebarOverlay: 24,
    filePanelOverlay: 30,
    previewOverlay: "rgba(251, 249, 240, 0.14)",
    nameKey: "appearance.look.softClay",
    descriptionKey: "appearance.look.softClayDescription",
  },
  {
    id: "quantum",
    theme: "cyber",
    backgroundId: "quantum-circuit",
    overlay: 56,
    blur: 0,
    sidebarOverlay: 44,
    filePanelOverlay: 50,
    previewOverlay: "rgba(7, 25, 28, 0.4)",
    nameKey: "appearance.look.quantum",
    descriptionKey: "appearance.look.quantumDescription",
  },
  {
    id: "white-future",
    theme: "nordic",
    backgroundId: "white-future",
    overlay: 20,
    blur: 0,
    sidebarOverlay: 22,
    filePanelOverlay: 28,
    previewOverlay: "rgba(245, 249, 252, 0.12)",
    nameKey: "appearance.look.whiteFuture",
    descriptionKey: "appearance.look.whiteFutureDescription",
  },
  {
    id: "jade",
    theme: "doodle",
    backgroundId: "jade-ascension",
    overlay: 24,
    blur: 0,
    sidebarOverlay: 26,
    filePanelOverlay: 32,
    previewOverlay: "rgba(255, 250, 240, 0.12)",
    nameKey: "appearance.look.jade",
    descriptionKey: "appearance.look.jadeDescription",
  },
  {
    id: "crimson",
    theme: "ember",
    backgroundId: "crimson-sword",
    overlay: 56,
    blur: 0,
    sidebarOverlay: 44,
    filePanelOverlay: 50,
    previewOverlay: "rgba(27, 17, 16, 0.4)",
    nameKey: "appearance.look.crimson",
    descriptionKey: "appearance.look.crimsonDescription",
  },
  {
    id: "moonlit",
    theme: "midnight",
    backgroundId: "moonlit-beauty",
    overlay: 54,
    blur: 0,
    sidebarOverlay: 42,
    filePanelOverlay: 48,
    previewOverlay: "rgba(11, 16, 32, 0.36)",
    nameKey: "appearance.look.moonlit",
    descriptionKey: "appearance.look.moonlitDescription",
  },
  {
    id: "alpine",
    theme: "nordic",
    backgroundId: "alpine-mirror",
    overlay: 22,
    blur: 0,
    sidebarOverlay: 24,
    filePanelOverlay: 30,
    previewOverlay: "rgba(245, 249, 252, 0.14)",
    nameKey: "appearance.look.alpine",
    descriptionKey: "appearance.look.alpineDescription",
  },
] as const;

export function AppearanceLooks() {
  const titleId = useId();
  const customTitleId = useId();
  const customFileRef = useRef<HTMLInputElement>(null);
  const { t } = useI18n();
  const { theme, themes, setThemeWithAction } = useTheme();
  const {
    preference,
    hydrated,
    busy,
    hasStoredCustom,
    customName: customArtworkName,
    customPreviewUrl,
    applyBuiltinPreset,
    selectStoredCustom,
    uploadCustom,
    setNone,
  } = useBackground();
  const [customLook, setCustomLook] = useState<SavedCustomLook | null>(null);
  const [customName, setCustomName] = useState("");
  const [customTheme, setCustomTheme] = useState<Theme>("light");

  useEffect(() => {
    const saved = parseSavedCustomLook(localStorage.getItem(CUSTOM_LOOK_STORAGE_KEY));
    setCustomLook(saved);
    if (saved) {
      setCustomName(saved.name);
      setCustomTheme(saved.theme);
    }
  }, []);

  const saveCustomLook = () => {
    const name = customName.trim().slice(0, 48);
    if (!name || !hasStoredCustom) return;
    const saved: SavedCustomLook = {
      schemaVersion: 1,
      name,
      theme: customTheme,
      overlay: preference.overlay,
      blur: preference.blur,
      sidebarOverlay: preference.sidebarOverlay,
      filePanelOverlay: preference.filePanelOverlay,
    };
    try { localStorage.setItem(CUSTOM_LOOK_STORAGE_KEY, JSON.stringify(saved)); } catch { /* Apply remains available for this session. */ }
    setCustomLook(saved);
  };

  const removeCustomLook = () => {
    try { localStorage.removeItem(CUSTOM_LOOK_STORAGE_KEY); } catch { /* In-memory removal still works. */ }
    setCustomLook(null);
  };

  return (
    <section aria-labelledby={titleId} style={{ paddingBottom: 16 }}>
      <div style={{ marginBottom: 9 }}>
        <h3 id={titleId} style={{ margin: 0, fontSize: "var(--text-sm)", fontWeight: 700 }}>
          {t("appearance.looks")}
        </h3>
        <p style={{ margin: "2px 0 0", color: "var(--text-dim)", fontSize: "var(--text-xs)" }}>
          {t("appearance.looksHint")}
        </p>
      </div>
      <div
        role="radiogroup"
        aria-label={t("appearance.looks")}
        style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(148px, 1fr))", gap: 9 }}
      >
        {APPEARANCE_LOOKS.map((look) => {
          const background = look.backgroundId ? getBackgroundPreset(look.backgroundId) : undefined;
          const selected = theme === look.theme
            && (look.backgroundId
              ? preference.source === "builtin" && preference.presetId === look.backgroundId
              : preference.source === "none")
            && (!look.backgroundId
              || (preference.overlay === look.overlay
                && preference.blur === look.blur
                && preference.sidebarOverlay === look.sidebarOverlay
                && preference.filePanelOverlay === look.filePanelOverlay));
          const artwork = background
            ? `linear-gradient(${look.previewOverlay}, ${look.previewOverlay}), url("${background.asset}")`
            : look.previewBackground;

          return (
            <button
              key={look.id}
              type="button"
              role="radio"
              aria-checked={selected}
              data-appearance-look={look.id}
              disabled={!hydrated || busy}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setThemeWithAction(look.theme, () => {
                  if (look.backgroundId) {
                    applyBuiltinPreset(look.backgroundId, {
                      overlay: look.overlay,
                      blur: look.blur,
                      sidebarOverlay: look.sidebarOverlay,
                      filePanelOverlay: look.filePanelOverlay,
                    });
                  } else {
                    setNone();
                  }
                }, {
                  x: rect.left + rect.width / 2,
                  y: rect.top + rect.height / 2,
                });
              }}
              style={{
                minWidth: 0,
                padding: 6,
                display: "grid",
                gap: 6,
                border: selected ? "1px solid var(--accent)" : "1px solid var(--border)",
                borderRadius: "var(--radius-control)",
                background: selected ? "var(--bg-selected)" : "var(--bg)",
                color: "var(--text)",
                cursor: !hydrated || busy ? "not-allowed" : "pointer",
                opacity: !hydrated || busy ? 0.62 : 1,
                textAlign: "left",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  position: "relative",
                  display: "block",
                  width: "100%",
                  aspectRatio: "16 / 7",
                  overflow: "hidden",
                  border: "1px solid color-mix(in srgb, var(--border) 78%, transparent)",
                  borderRadius: "calc(var(--radius-control) - 2px)",
                  backgroundColor: background?.appearance === "dark" ? "#172554" : "#fffaf0",
                  backgroundImage: artwork,
                  backgroundPosition: "center",
                  backgroundSize: "cover",
                }}
              >
                {selected && (
                  <span style={{ position: "absolute", right: 6, top: 6, width: 18, height: 18, display: "grid", placeItems: "center", borderRadius: "50%", background: "var(--accent)", color: "#fff" }}>
                    <AliIcon name="check" size={11} />
                  </span>
                )}
              </span>
              <span style={{ minWidth: 0, padding: "0 2px 2px" }}>
                <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "var(--text-xs)", fontWeight: 650 }}>
                  {t(look.nameKey)}
                </span>
                <span style={{ display: "block", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: "var(--text-xs)" }}>
                  {t(look.descriptionKey)}
                </span>
              </span>
            </button>
          );
        })}
        {customLook && hasStoredCustom ? (
          <button
            type="button"
            role="radio"
            aria-checked={theme === customLook.theme && preference.source === "custom"}
            data-appearance-look="custom"
            disabled={!hydrated || busy}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setThemeWithAction(customLook.theme, () => {
                void selectStoredCustom(customLook);
              }, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
            }}
            style={{
              minWidth: 0,
              padding: 6,
              display: "grid",
              gap: 6,
              border: theme === customLook.theme && preference.source === "custom" ? "1px solid var(--accent)" : "1px solid var(--border)",
              borderRadius: "var(--radius-control)",
              background: theme === customLook.theme && preference.source === "custom" ? "var(--bg-selected)" : "var(--bg)",
              color: "var(--text)",
              cursor: !hydrated || busy ? "not-allowed" : "pointer",
              opacity: !hydrated || busy ? 0.62 : 1,
              textAlign: "left",
            }}
          >
            <span aria-hidden="true" style={{ display: "block", width: "100%", aspectRatio: "16 / 7", border: "1px solid var(--border)", borderRadius: "calc(var(--radius-control) - 2px)", background: customPreviewUrl ? `url("${customPreviewUrl}") center / cover` : "var(--bg-panel)" }} />
            <span style={{ minWidth: 0, padding: "0 2px 2px" }}>
              <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "var(--text-xs)", fontWeight: 650 }}>{customLook.name}</span>
              <span style={{ display: "block", marginTop: 1, color: "var(--text-dim)", fontSize: "var(--text-xs)" }}>{t("appearance.custom.apply")}</span>
            </span>
          </button>
        ) : null}
      </div>

      <details className="appearance-custom-details">
        <summary id={customTitleId}>{t("appearance.custom.title")}</summary>
      <div aria-labelledby={customTitleId} style={{ marginTop: 14, padding: 12, display: "grid", gap: 10, border: "1px solid var(--border)", borderRadius: "var(--radius-surface)", background: "color-mix(in srgb, var(--bg-panel) 78%, transparent)" }}>
        <div>
          <p style={{ margin: "3px 0 0", color: "var(--text-dim)", fontSize: "var(--text-xs)", lineHeight: 1.5 }}>{t("appearance.custom.description")}</p>
        </div>
        <div style={{ padding: "8px 10px", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text-muted)", fontSize: "var(--text-xs)", lineHeight: 1.55 }}>
          <strong style={{ color: "var(--text)" }}>{t("appearance.custom.requirements")}</strong>
          <ul style={{ margin: "5px 0 0", paddingLeft: 18 }}>
            <li>{t("appearance.custom.requirementName")}</li>
            <li>{t("appearance.custom.requirementArtwork")}</li>
            <li>{t("appearance.custom.requirementPalette")}</li>
            <li>{t("appearance.custom.requirementTuning")}</li>
            <li>{t("appearance.custom.requirementRights")}</li>
          </ul>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(160px, 0.7fr)", gap: 9 }}>
          <label style={{ display: "grid", gap: 5, color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>
            <span>{t("appearance.custom.name")}</span>
            <input value={customName} maxLength={48} placeholder={t("appearance.custom.namePlaceholder")} onChange={(event) => setCustomName(event.currentTarget.value)} style={{ minHeight: 34, padding: "6px 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", font: "inherit" }} />
          </label>
          <label style={{ display: "grid", gap: 5, color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>
            <span>{t("appearance.custom.palette")}</span>
            <select value={customTheme} onChange={(event) => setCustomTheme(event.currentTarget.value as Theme)} style={{ minHeight: 34, padding: "6px 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", font: "inherit" }}>
              {themes.map((preset) => <option key={preset.id} value={preset.id}>{t(`theme.${preset.id}.name`)}</option>)}
            </select>
          </label>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <button type="button" disabled={busy} onClick={() => customFileRef.current?.click()} style={{ minHeight: 32, padding: "5px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", cursor: busy ? "not-allowed" : "pointer" }}>
            {hasStoredCustom ? t("appearance.custom.replaceArtwork") : t("appearance.custom.chooseArtwork")}
          </button>
          <input ref={customFileRef} type="file" hidden accept={SUPPORTED_BACKGROUND_MIME_TYPES.join(",")} disabled={busy} onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void uploadCustom(file); event.currentTarget.value = ""; }} />
          {hasStoredCustom ? <span style={{ color: "var(--text-dim)", fontSize: "var(--text-xs)" }}>{t("appearance.custom.artworkReady", { name: customArtworkName || t("background.localImage") })}</span> : null}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button type="button" disabled={!hydrated || busy || !hasStoredCustom || !customName.trim()} onClick={saveCustomLook} style={{ minHeight: 32, padding: "5px 11px", border: 0, borderRadius: "var(--radius-control)", background: "var(--btn-primary-bg, var(--accent))", color: "var(--btn-primary-fg, #fff)", cursor: !hydrated || busy || !hasStoredCustom || !customName.trim() ? "not-allowed" : "pointer", opacity: !hydrated || busy || !hasStoredCustom || !customName.trim() ? 0.55 : 1 }}>
            {t("appearance.custom.save")}
          </button>
          {customLook ? <button type="button" onClick={removeCustomLook} style={{ minHeight: 32, padding: "5px 11px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}>{t("appearance.custom.delete")}</button> : null}
          {customLook ? <span style={{ alignSelf: "center", color: "var(--text-dim)", fontSize: "var(--text-xs)" }}>{t("appearance.custom.saved", { name: customLook.name })}</span> : null}
        </div>
      </div>
      </details>
    </section>
  );
}
