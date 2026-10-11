"use client";

import { useEffect, useId, useState } from "react";
import { useInterfaceTransparency } from "@/hooks/useInterfaceTransparency";
import { useI18n } from "@/hooks/useI18n";
import { AliIcon } from "./AliIcon";
import styles from "./InterfaceTransparencySettings.module.css";

export function InterfaceTransparencySettings() {
  const { t } = useI18n();
  const { transparency, setTransparency, reset } = useInterfaceTransparency();
  const id = useId();
  const [numberDraft, setNumberDraft] = useState(String(transparency));
  useEffect(() => { setNumberDraft(String(transparency)); }, [transparency]);
  function commitNumber() {
    if (numberDraft.trim() === "") { setNumberDraft(String(transparency)); return; }
    const next = Math.min(100, Math.max(0, Math.round(Number(numberDraft))));
    if (Number.isFinite(next)) { setTransparency(next); setNumberDraft(String(next)); }
    else setNumberDraft(String(transparency));
  }
  return (
    <section className={styles.section} aria-labelledby={`${id}-title`}>
      <div className={styles.header}>
        <h3 id={`${id}-title`}>{t("appearance.transparency.title")}</h3>
      </div>
      <p id={`${id}-hint`}>{t("appearance.transparency.liveHint")}</p>
      <div className={styles.preview} aria-hidden="true">
        <div className={styles.previewColumn}>
          <span className={styles.previewTitle}>{t("appearance.transparency.composer")}</span>
          <div className={styles.previewComposer}>
            <span>{t("appearance.transparency.messagePlaceholder")}</span>
            <div className={styles.composerTools}><AliIcon name="plus" size={19} /><AliIcon name="attachment" size={19} /><AliIcon name="microphone" size={19} /><span className={styles.send}><AliIcon name="send" size={18} /></span></div>
          </div>
        </div>
        <div className={styles.previewColumn}>
          <span className={styles.previewTitle}>{t("appearance.transparency.search")}</span>
          <div className={styles.previewSearch}>
            <div className={styles.searchInput}><AliIcon name="search" size={19} /><span>{t("appearance.transparency.searchPlaceholder")}</span></div>
            <div className={styles.searchResult}><AliIcon name="setting" size={17} /><span>{t("appearance.transparency.settingsResult")}</span><AliIcon name="arrowright" size={14} /></div>
            <div className={styles.searchResult}><AliIcon name="message" size={17} /><span>{t("appearance.transparency.recentResult")}</span><AliIcon name="arrowright" size={14} /></div>
          </div>
        </div>
      </div>
      <div className={styles.label}>
        <label htmlFor={id}>{t("appearance.transparency.title")}</label>
        <label className={styles.number}><span className={styles.srOnly}>{t("appearance.transparency.value")}</span>
          <input type="number" min={0} max={100} step={1} inputMode="numeric" value={numberDraft}
            onChange={event => { const value = event.currentTarget.value; setNumberDraft(value); if (value !== "" && Number(value) >= 0 && Number(value) <= 100) setTransparency(Number(value)); }}
            onBlur={commitNumber} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
          <span aria-hidden="true">%</span>
        </label>
      </div>
      <input id={id} className={styles.range} type="range" min={0} max={100} step={1}
        value={transparency} aria-describedby={`${id}-hint`} aria-valuetext={`${transparency}%`}
        onChange={event => setTransparency(Number(event.currentTarget.value))} />
      <div className={styles.ends}><span>{t("appearance.transparency.opaque")}</span><span>{t("appearance.transparency.clear")}</span></div>
      <div className={styles.footer}><p>{t("appearance.transparency.appliesTo")}</p><button type="button" onClick={reset}>{t("appearance.transparency.reset")}</button></div>
      <p>{t("appearance.transparency.readability")}</p>
      <p className={styles.reduced}>{t("appearance.transparency.reduced")}</p>
    </section>
  );
}
