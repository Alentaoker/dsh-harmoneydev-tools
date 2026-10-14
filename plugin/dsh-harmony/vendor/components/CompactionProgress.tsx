"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { CompactResultInfo } from "@/hooks/useAgentSession";
import { AliIcon } from "./AliIcon";

/** Elapsed time belongs to the server's compaction, not this view's lifetime. */
export function CompactionProgress({ startedAt, onStop }: { startedAt: number | null; onStop?: () => void }) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const seconds = startedAt === null ? null : Math.max(0, Math.floor((now - startedAt) / 1000));
  const elapsed = seconds === null ? null : [Math.floor(seconds / 60), seconds % 60]
    .map((part) => String(part).padStart(2, "0")).join(":");

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="compaction-notice compaction-progress">
      <div className="compaction-notice-heading">
        <span className="compaction-progress-spinner" aria-hidden="true" />
        <div className="compaction-notice-copy">
          <div className="compaction-notice-title" role="status" aria-live="polite">{t("chat.compactingWait")}</div>
          <p className="compaction-notice-description">{t("chat.compactingHint")}</p>
        </div>
        {seconds !== null ? (
          <span className="compaction-progress-elapsed" role="timer" aria-label={t("chat.compactingElapsed", { seconds })}>
            {elapsed}
          </span>
        ) : null}
      </div>
      <div className="compaction-progress-track" role="progressbar" aria-label={t("chat.compactContext")}>
        <span />
      </div>
      <div className="compaction-progress-footer">
        <span>{t("chat.compactingResultHint")}</span>
        {onStop ? (
          <button type="button" className="compaction-progress-stop" onClick={onStop}>
            <span className="compaction-progress-stop-icon" aria-hidden="true" />
            {t("chat.stopCompaction")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function formatResultTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

export function CompactionResult({ result, onDismiss }: { result: CompactResultInfo; onDismiss?: () => void }) {
  const { t } = useI18n();
  const saved = result.tokensBefore - result.estimatedTokensAfter;

  return (
    <div className="compaction-notice compaction-result">
      <div className="compaction-notice-heading">
        <AliIcon name="check-circle" size={32} className="compaction-result-icon" />
        <div className="compaction-notice-title" role="status" aria-live="polite">{t("chat.compactedTitle")}</div>
        {onDismiss ? (
          <button type="button" className="compaction-result-dismiss" onClick={onDismiss} aria-label={t("chat.dismissCompactResult")} title={t("chat.dismissCompactResult")}>
            <AliIcon name="close" size={18} />
          </button>
        ) : null}
      </div>
      <div className="compaction-result-tokens" role="group" aria-label={`${t("chat.compactTokensBefore", { tokens: result.tokensBefore })}; ${t("chat.compactTokensAfter", { tokens: result.estimatedTokensAfter })}`}>
        <span className="compaction-result-before" title={t("chat.compactTokensBefore", { tokens: result.tokensBefore })}>{formatResultTokens(result.tokensBefore)}</span>
        <AliIcon name="arrowright" size={18} />
        <span className="compaction-result-after" title={t("chat.compactTokensAfter", { tokens: result.estimatedTokensAfter })}>{formatResultTokens(result.estimatedTokensAfter)}</span>
        <span className="compaction-result-unit">tokens</span>
      </div>
      <p className="compaction-notice-description">
        {saved > 0 ? t("chat.compactedSavings", { saved: formatResultTokens(saved) }) : t("chat.compactedEstimate")}
      </p>
    </div>
  );
}
