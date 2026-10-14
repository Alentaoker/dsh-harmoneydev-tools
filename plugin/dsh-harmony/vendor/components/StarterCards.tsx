"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { GitStatusResponse } from "@/lib/git-types";
import { buildStarters, type Starter, type StarterSignals } from "@/lib/starters";
import type { ProjectStarterSignals } from "@/lib/project-info";
import { AliIcon, type AliIconName } from "./AliIcon";
import styles from "./StarterCards.module.css";

export function StarterCards({ cwd, onSelect }: { cwd?: string | null; onSelect: (prompt: string) => void }) {
  const { t } = useI18n();
  const normalizedCwd = cwd ?? null;
  const [signalSnapshot, setSignalSnapshot] = useState<{ cwd: string | null; signals: StarterSignals }>(() => ({
    cwd: normalizedCwd,
    signals: emptySignals(Boolean(cwd)),
  }));

  useEffect(() => {
    if (!cwd) {
      setSignalSnapshot({ cwd: null, signals: emptySignals(false) });
      return;
    }
    const controller = new AbortController();
    const requestCwd = cwd;
    const encoded = encodeURIComponent(cwd);
    Promise.all([
      fetch(`/api/project-info?cwd=${encoded}&starters=fast`, { signal: controller.signal }).then((response) => response.ok ? response.json() : {}),
      fetch(`/api/git/status?cwd=${encoded}`, { signal: controller.signal }).then((response) => response.ok ? response.json() : {}),
    ]).then(([project, git]: [{ starterSignals?: ProjectStarterSignals }, Partial<GitStatusResponse>]) => {
      const starterSignals = project.starterSignals ?? emptySignals(true);
      setSignalSnapshot({
        cwd: requestCwd,
        signals: {
          ...starterSignals,
          hasProject: true,
          hasUncommittedChanges: Array.isArray(git.files) && git.files.length > 0,
        },
      });
    }).catch(() => {
      if (!controller.signal.aborted) {
        setSignalSnapshot({ cwd: requestCwd, signals: emptySignals(true) });
      }
    });
    return () => controller.abort();
  }, [cwd]);

  const signals = signalSnapshot.cwd === normalizedCwd
    ? signalSnapshot.signals
    : emptySignals(Boolean(cwd));
  const starters: Starter[] = buildStarters(signals, t);
  return (
    <div className={styles.root} aria-label={t("starters.label")}>
      {starters.map((starter) => (
        <button key={starter.id} type="button" className={styles.card} onClick={() => onSelect(starter.prompt)}>
          <AliIcon name={starter.icon as AliIconName} size={14} />
          <span className={styles.label}>{starter.prompt}</span>
        </button>
      ))}
    </div>
  );
}

function emptySignals(hasProject: boolean): StarterSignals {
  return { hasProject, hasUncommittedChanges: false, hasReadme: false, hasTests: false, hasPackageJson: false, hasOutdatedDependencies: false };
}
