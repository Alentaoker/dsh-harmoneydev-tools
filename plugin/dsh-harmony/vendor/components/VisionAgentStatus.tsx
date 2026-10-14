"use client";

import type { ExtensionStatusItem } from "@/lib/types";
import {
  parseVisionAgentStatus,
  VISION_AGENT_STATUS_KEY,
  type VisionAgentStatus as VisionAgentStatusValue,
} from "@/lib/vision-agent-status";
import { AliIcon } from "./AliIcon";

type Translate = (key: string, params?: Record<string, string | number>) => string;

export function findVisionAgentStatus(statuses: readonly ExtensionStatusItem[]): VisionAgentStatusValue | null {
  const item = statuses.find((status) => status.key === VISION_AGENT_STATUS_KEY);
  return parseVisionAgentStatus(item?.text);
}

export function visionAgentStatusLabel(status: VisionAgentStatusValue, t: Translate): string {
  if (status.phase === "failed") return t("chat.visionFailedTitle");
  if (status.phase === "ready") return t("chat.visionReady");
  return status.imageCount === 1
    ? t("chat.visionAnalyzingOne")
    : t("chat.visionAnalyzingMany", { count: status.imageCount });
}

export function VisionAgentStatus({
  status,
  t,
  onRetry,
  onConfigure,
  retryDisabled = false,
}: {
  status: VisionAgentStatusValue;
  t: Translate;
  onRetry?: () => void;
  onConfigure?: () => void;
  retryDisabled?: boolean;
}) {
  if (status.phase !== "failed") {
    const label = visionAgentStatusLabel(status, t);
    return (
      <div
        className="vision-agent-progress"
        data-phase={status.phase}
        role="status"
        aria-live="polite"
        aria-busy={status.phase === "analyzing"}
      >
        <span className="vision-agent-progress-icon" aria-hidden="true">
          <AliIcon name={status.phase === "ready" ? "check" : "eye"} size={16} />
        </span>
        <span>{label}</span>
      </div>
    );
  }

  return (
    <div className="vision-agent-failure" role="alert">
      <span className="vision-agent-failure-icon" aria-hidden="true">
        <AliIcon name="warning" size={16} />
      </span>
      <div className="vision-agent-failure-content">
        <strong>{t("chat.visionFailedTitle")}</strong>
        <span>{t("chat.visionFailedBody")}</span>
        <div className="vision-agent-failure-actions">
          {onRetry ? (
            <button type="button" onClick={onRetry} disabled={retryDisabled}>
              <AliIcon name="reload" size={13} />
              {t("chat.visionRetry")}
            </button>
          ) : null}
          {onConfigure ? (
            <button type="button" onClick={onConfigure}>
              <AliIcon name="setting" size={13} />
              {t("chat.visionConfigure")}
            </button>
          ) : null}
          <details>
            <summary>{t("chat.visionFailureDetails")}</summary>
            <p>{status.reason}</p>
          </details>
        </div>
      </div>
    </div>
  );
}
