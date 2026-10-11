"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useI18n } from "@/hooks/useI18n";
import { fetchModelCatalog } from "@/lib/model-catalog-client";
import {
  FIRST_RUN_ONBOARDING_STEPS,
  createFirstRunOnboardingState,
  nextFirstRunOnboardingStep,
  readFirstRunOnboardingState,
  resolveInitialFirstRunOnboardingState,
  writeFirstRunOnboardingState,
  type FirstRunOnboardingState,
  type FirstRunOnboardingStep,
} from "@/lib/first-run-onboarding";
import { AliIcon, type AliIconName } from "./AliIcon";
import styles from "./FirstRunOnboarding.module.css";

interface Props {
  modelCwd?: string | null;
  modelsRefreshKey: number;
  projectReady: boolean;
  projectName?: string | null;
  promptSubmittedKey: number;
  restartKey: number;
  settingsOpen: boolean;
  onOpenModels: () => void;
  onChooseProject: () => void;
  onPrepareFirstPrompt: (prompt: string) => void;
}

type Presentation = "hidden" | "panel" | "paused" | "complete";

const STEP_ICONS: Record<FirstRunOnboardingStep, AliIconName> = {
  model: "api",
  project: "folder-open",
  chat: "message",
};

export function FirstRunOnboarding({
  modelCwd,
  modelsRefreshKey,
  projectReady,
  projectName,
  promptSubmittedKey,
  restartKey,
  settingsOpen,
  onOpenModels,
  onChooseProject,
  onPrepareFirstPrompt,
}: Props) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const lastRestartKeyRef = useRef(restartKey);
  const lastPromptSubmittedKeyRef = useRef(promptSubmittedKey);
  const [mounted, setMounted] = useState(false);
  const [state, setState] = useState<FirstRunOnboardingState | null>(null);
  const [presentation, setPresentation] = useState<Presentation>("hidden");
  const [modelReady, setModelReady] = useState<boolean | null>(null);

  const persist = useCallback((next: FirstRunOnboardingState) => {
    setState(next);
    writeFirstRunOnboardingState(window.localStorage, next);
  }, []);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    let cancelled = false;
    const stored = readFirstRunOnboardingState(window.localStorage);
    if (stored) {
      setState(stored);
      setPresentation(stored.status === "active" ? "panel" : "hidden");
      return () => { cancelled = true; };
    }

    void fetch("/api/sessions", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as { sessions?: unknown[] };
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return Array.isArray(payload.sessions) ? payload.sessions.length : 0;
      })
      .catch(() => null)
      .then((sessionCount) => {
        if (cancelled || sessionCount === null) return;
        const initial = resolveInitialFirstRunOnboardingState(null, sessionCount);
        persist(initial);
        setPresentation(initial.status === "active" ? "panel" : "hidden");
      });
    return () => { cancelled = true; };
  }, [persist]);

  useEffect(() => {
    if (restartKey === lastRestartKeyRef.current) return;
    lastRestartKeyRef.current = restartKey;
    const restarted = createFirstRunOnboardingState();
    persist(restarted);
    setPresentation("panel");
  }, [persist, restartKey]);

  useEffect(() => {
    if (settingsOpen || state?.status !== "active" || state.step !== "model") return;
    const controller = new AbortController();
    setModelReady(null);
    void fetchModelCatalog({
      cwd: modelCwd ?? undefined,
      forceRefresh: modelsRefreshKey > 0,
      signal: controller.signal,
    }).then((catalog) => {
      setModelReady((catalog.modelList?.length ?? 0) > 0);
    }).catch(() => {
      if (!controller.signal.aborted) setModelReady(false);
    });
    return () => controller.abort();
  }, [modelCwd, modelsRefreshKey, settingsOpen, state?.status, state?.step]);

  useEffect(() => {
    if (presentation !== "paused" || state?.step !== "project" || !projectReady) return;
    setPresentation("panel");
  }, [presentation, projectReady, state?.step]);

  useEffect(() => {
    if (promptSubmittedKey === lastPromptSubmittedKeyRef.current) return;
    lastPromptSubmittedKeyRef.current = promptSubmittedKey;
    if (state?.status !== "active" || state.step !== "chat") return;
    persist(createFirstRunOnboardingState("completed", "chat"));
    setPresentation("complete");
  }, [persist, promptSubmittedKey, state]);

  const pause = useCallback(() => setPresentation("paused"), []);
  useFocusTrap(panelRef, mounted && !settingsOpen && (presentation === "panel" || presentation === "complete"), {
    onEscape: pause,
  });

  const stepIndex = state ? FIRST_RUN_ONBOARDING_STEPS.indexOf(state.step) : 0;
  const steps = useMemo(() => FIRST_RUN_ONBOARDING_STEPS.map((step) => ({
    id: step,
    icon: STEP_ICONS[step],
    label: t(`onboarding.step.${step}`),
  })), [t]);

  const advance = useCallback(() => {
    if (!state || state.status !== "active") return;
    persist(createFirstRunOnboardingState("active", nextFirstRunOnboardingStep(state.step)));
  }, [persist, state]);

  const goBack = useCallback(() => {
    if (!state || state.status !== "active") return;
    const index = FIRST_RUN_ONBOARDING_STEPS.indexOf(state.step);
    const previous = FIRST_RUN_ONBOARDING_STEPS[Math.max(0, index - 1)];
    persist(createFirstRunOnboardingState("active", previous));
  }, [persist, state]);

  const dismiss = useCallback(() => {
    const step = state?.step ?? "model";
    persist(createFirstRunOnboardingState("dismissed", step));
    setPresentation("hidden");
  }, [persist, state?.step]);

  const handlePrimaryAction = useCallback(() => {
    if (!state) return;
    if (state.step === "model") {
      if (modelReady) advance();
      else onOpenModels();
      return;
    }
    if (state.step === "project") {
      if (projectReady) advance();
      else {
        setPresentation("paused");
        onChooseProject();
      }
      return;
    }
    setPresentation("paused");
    onPrepareFirstPrompt(t("onboarding.chat.example"));
  }, [advance, modelReady, onChooseProject, onOpenModels, onPrepareFirstPrompt, projectReady, state, t]);

  if (!mounted || !state || settingsOpen || presentation === "hidden") return null;

  if (presentation === "paused") {
    return createPortal(
      <button type="button" className={styles.resumePill} onClick={() => setPresentation("panel")}>
        <span className={styles.resumeIcon}><AliIcon name={STEP_ICONS[state.step]} size={15} /></span>
        <span>
          <strong>{t("onboarding.resume")}</strong>
          <small>{t(`onboarding.resume.${state.step}`)}</small>
        </span>
        <AliIcon name="arrowright" size={14} />
      </button>,
      document.body,
    );
  }

  const complete = presentation === "complete";
  const ready = state.step === "model" ? modelReady === true : state.step === "project" ? projectReady : false;
  const checking = state.step === "model" && modelReady === null;
  const statusKey = state.step === "model"
    ? modelReady === null ? "onboarding.model.checking" : modelReady ? "onboarding.model.ready" : "onboarding.model.required"
    : state.step === "project"
      ? projectReady ? "onboarding.project.ready" : "onboarding.project.required"
      : "onboarding.chat.ready";
  const statusParams = state.step === "project" && projectReady && projectName ? { project: projectName } : undefined;
  const primaryKey = state.step === "model"
    ? modelReady ? "onboarding.next" : "onboarding.model.action"
    : state.step === "project"
      ? projectReady ? "onboarding.next" : "onboarding.project.action"
      : "onboarding.chat.action";

  return createPortal(
    <div className={styles.backdrop}>
      <div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-run-onboarding-title"
      >
        {complete ? (
          <div className={styles.completion}>
            <div className={styles.completionMark}><AliIcon name="check" size={28} /></div>
            <span className={styles.eyebrow}>{t("onboarding.complete.eyebrow")}</span>
            <h2 id="first-run-onboarding-title">{t("onboarding.complete.title")}</h2>
            <p>{t("onboarding.complete.description")}</p>
            <button type="button" className={styles.primaryButton} onClick={() => setPresentation("hidden")}>
              {t("onboarding.complete.action")}
              <AliIcon name="arrowright" size={15} />
            </button>
          </div>
        ) : (
          <>
            <header className={styles.header}>
              <div>
                <span className={styles.eyebrow}>{t("onboarding.eyebrow")}</span>
                <h2 id="first-run-onboarding-title">{t("onboarding.title")}</h2>
                <p>{t("onboarding.description")}</p>
              </div>
              <button type="button" className={styles.skipButton} onClick={dismiss}>{t("onboarding.skip")}</button>
            </header>

            <ol className={styles.progress} aria-label={t("onboarding.progressLabel")}>
              {steps.map((step, index) => {
                const current = index === stepIndex;
                const done = index < stepIndex;
                return (
                  <li key={step.id} data-current={current || undefined} data-complete={done || undefined}>
                    <span className={styles.stepIcon}>
                      <AliIcon name={done ? "check" : step.icon} size={14} />
                    </span>
                    <span>{step.label}</span>
                  </li>
                );
              })}
            </ol>

            <main className={styles.stepBody}>
              <div className={styles.heroIcon}><AliIcon name={STEP_ICONS[state.step]} size={25} /></div>
              <span className={styles.stepNumber}>{t("onboarding.stepNumber", { current: stepIndex + 1, total: steps.length })}</span>
              <h3>{t(`onboarding.${state.step}.title`)}</h3>
              <p>{t(`onboarding.${state.step}.description`)}</p>
              <div className={styles.status} data-ready={ready || undefined} role="status">
                <AliIcon name={ready ? "check-circle" : checking ? "reload" : "info"} size={16} />
                <span>{t(statusKey, statusParams)}</span>
              </div>
              {state.step === "chat" ? (
                <button
                  type="button"
                  className={styles.example}
                  onClick={() => {
                    setPresentation("paused");
                    onPrepareFirstPrompt(t("onboarding.chat.example"));
                  }}
                >
                  <AliIcon name="compose" size={15} />
                  <span>{t("onboarding.chat.example")}</span>
                </button>
              ) : null}
            </main>

            <footer className={styles.footer}>
              <button type="button" className={styles.secondaryButton} disabled={stepIndex === 0} onClick={goBack}>
                <AliIcon name="arrowleft" size={14} />
                {t("onboarding.back")}
              </button>
              <span>{t("onboarding.progress", { current: stepIndex + 1, total: steps.length })}</span>
              <button type="button" className={styles.primaryButton} disabled={checking} onClick={handlePrimaryAction}>
                {t(checking ? "onboarding.model.checkingAction" : primaryKey)}
                <AliIcon name="arrowright" size={15} />
              </button>
            </footer>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
