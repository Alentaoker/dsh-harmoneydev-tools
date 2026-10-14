"use client";

import { useI18n } from "@/hooks/useI18n";
import styles from "./CapabilityPrimer.module.css";

export type PiCapabilityKind = "extension" | "skill" | "plugin";

const CAPABILITY_KINDS: PiCapabilityKind[] = ["extension", "skill", "plugin"];

export function CapabilityPrimer({ current }: { current: PiCapabilityKind }) {
  const { t } = useI18n();
  return (
    <aside className={styles.primer} aria-label={t("capabilities.heading")}>
      <div className={styles.heading}>{t("capabilities.heading")}</div>
      <div className={styles.grid}>
        {CAPABILITY_KINDS.map((kind) => (
          <div className={styles.item} data-current={kind === current ? "true" : undefined} key={kind}>
            <div className={styles.titleRow}>
              {t(`capabilities.${kind}.title`)}
              {kind === current ? <span className={styles.badge}>{t("capabilities.currentPage")}</span> : null}
            </div>
            <div className={styles.description}>{t(`capabilities.${kind}.description`)}</div>
          </div>
        ))}
      </div>
    </aside>
  );
}
