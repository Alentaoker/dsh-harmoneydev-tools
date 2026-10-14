"use client";

import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useI18n } from "@/hooks/useI18n";
import { useDialogCountdown } from "@/hooks/useExtensionDialog";
import type { ExtensionUiRequest } from "@/lib/types";
import { USER_INPUT_MAX_TEXT_LENGTH, type UserInputAnswers } from "@/lib/user-input";
import { AliIcon } from "./AliIcon";
import styles from "./UserInputCard.module.css";

type UserInputRequest = Extract<ExtensionUiRequest, { method: "request_user_input" }>;

export function UserInputCard({
  request,
  onRespond,
}: {
  request: UserInputRequest;
  onRespond: (request: UserInputRequest, response: { answers: UserInputAnswers } | { cancelled: true }) => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstControlRef = useRef<HTMLElement>(null);
  const [answers, setAnswers] = useState<UserInputAnswers>(() => (
    Object.fromEntries(request.questions.map((question) => [question.id, []]))
  ));
  const [customText, setCustomText] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const remainingSeconds = useDialogCountdown(request.expiresAt);
  const expired = () => Boolean(request.expiresAt && Date.now() >= request.expiresAt);

  // The "Other" free-text answer for select questions is kept outside the
  // selection state and merged in only when it is non-empty, so a custom
  // answer can never be mistaken for one of the predefined option labels.
  const mergedAnswers = useMemo<UserInputAnswers>(() => {
    const merged: UserInputAnswers = {};
    for (const question of request.questions) {
      const values = [...(answers[question.id] ?? [])];
      const custom = (customText[question.id] ?? "").trim();
      if (custom) values.push(custom);
      merged[question.id] = values;
    }
    return merged;
  }, [answers, customText, request.questions]);

  const complete = request.questions.every((question) => (
    !question.required || (mergedAnswers[question.id]?.some((value) => value.trim().length > 0) ?? false)
  ));

  const cancel = () => { if (!expired()) onRespond(request, { cancelled: true }); };
  useFocusTrap(dialogRef, remainingSeconds !== 0, { initialFocus: firstControlRef, onEscape: cancel });

  const setSingle = (id: string, value: string) => {
    setAnswers((current) => ({ ...current, [id]: [value] }));
    setCustomText((current) => ({ ...current, [id]: "" }));
  };
  const toggleMultiple = (id: string, value: string) => {
    setAnswers((current) => {
      const selected = current[id] ?? [];
      return {
        ...current,
        [id]: selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value],
      };
    });
  };
  const setText = (id: string, value: string) => {
    setAnswers((current) => ({ ...current, [id]: value ? [value] : [] }));
  };
  const setCustom = (id: string, value: string, exclusive: boolean) => {
    setCustomText((current) => ({ ...current, [id]: value }));
    if (exclusive && value.trim()) {
      // A single-select custom answer replaces any chosen option label.
      setAnswers((current) => (
        (current[id]?.length ?? 0) > 0 ? { ...current, [id]: [] } : current
      ));
    }
  };
  const submit = () => {
    if (expired()) return;
    setAttempted(true);
    if (!complete) return;
    onRespond(request, { answers: mergedAnswers });
  };

  if (remainingSeconds === 0) return null;

  return createPortal(
    <div className={styles.backdrop} role="presentation">
      <div
        ref={dialogRef}
        className={styles.card}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`user-input-title-${request.id}`}
        aria-describedby={[request.description ? `user-input-description-${request.id}` : "", remainingSeconds !== null ? `user-input-timeout-${request.id}` : ""].filter(Boolean).join(" ") || undefined}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            submit();
          }
        }}
      >
        <header className={styles.header}>
          <div className={styles.icon} aria-hidden="true"><AliIcon name="question" size={17} /></div>
          <div className={styles.heading}>
            <div className={styles.eyebrow}>{t("userInput.eyebrow")}</div>
            <h2 id={`user-input-title-${request.id}`}>{request.title}</h2>
            {request.description ? <p id={`user-input-description-${request.id}`}>{request.description}</p> : null}
          </div>
          <button className={styles.close} type="button" onClick={cancel} aria-label={t("chat.cancel")} title={t("chat.cancel")}>
            <AliIcon name="close" size={15} />
          </button>
        </header>

        <div className={styles.body}>
          {request.questions.map((question, questionIndex) => {
            const selected = mergedAnswers[question.id] ?? [];
            const missing = attempted && question.required && !selected.some((value) => value.trim());
            const customValue = customText[question.id] ?? "";
            const customActive = customValue.trim().length > 0;
            return (
              <section className={styles.question} key={question.id} data-invalid={missing || undefined}>
                <div className={styles.questionMeta}>
                  <span>{question.header || t("userInput.question", { count: questionIndex + 1 })}</span>
                  <span>{question.required ? t("userInput.required") : t("userInput.optional")}</span>
                </div>
                <h3>{question.question}</h3>
                {question.kind === "text" ? (
                  question.multiline ? (
                    <textarea
                      ref={questionIndex === 0 ? firstControlRef as React.RefObject<HTMLTextAreaElement> : undefined}
                      className={styles.textField}
                      value={selected[0] ?? ""}
                      maxLength={USER_INPUT_MAX_TEXT_LENGTH}
                      rows={5}
                      placeholder={question.placeholder || t("userInput.textPlaceholder")}
                      onChange={(event) => setText(question.id, event.target.value)}
                      aria-invalid={missing}
                    />
                  ) : (
                    <input
                      ref={questionIndex === 0 ? firstControlRef as React.RefObject<HTMLInputElement> : undefined}
                      className={styles.textField}
                      value={selected[0] ?? ""}
                      maxLength={USER_INPUT_MAX_TEXT_LENGTH}
                      placeholder={question.placeholder || t("userInput.textPlaceholder")}
                      onChange={(event) => setText(question.id, event.target.value)}
                      aria-invalid={missing}
                    />
                  )
                ) : (
                  <div className={styles.options} role={question.kind === "single_select" ? "radiogroup" : "group"}>
                    {question.options?.map((option, optionIndex) => {
                      const checked = selected.includes(option.label);
                      return (
                        <button
                          ref={questionIndex === 0 && optionIndex === 0 ? firstControlRef as React.RefObject<HTMLButtonElement> : undefined}
                          key={option.label}
                          type="button"
                          className={styles.option}
                          data-selected={checked || undefined}
                          role={question.kind === "single_select" ? "radio" : "checkbox"}
                          aria-checked={checked}
                          onClick={() => question.kind === "single_select"
                            ? setSingle(question.id, option.label)
                            : toggleMultiple(question.id, option.label)}
                        >
                          <span className={styles.control} aria-hidden="true">
                            {checked ? <AliIcon name="check" size={12} /> : null}
                          </span>
                          <span className={styles.optionCopy}>
                            <strong>{option.label}</strong>
                            {option.description ? <small>{option.description}</small> : null}
                          </span>
                        </button>
                      );
                    })}
                    <label className={styles.option} data-selected={customActive || undefined}>
                      <span className={styles.control} aria-hidden="true">
                        {customActive ? <AliIcon name="check" size={12} /> : null}
                      </span>
                      <span className={styles.customBody}>
                        <input
                          type="text"
                          className={styles.customField}
                          value={customValue}
                          maxLength={USER_INPUT_MAX_TEXT_LENGTH}
                          placeholder={t("userInput.otherPlaceholder")}
                          aria-label={t("userInput.other")}
                          aria-invalid={missing}
                          onChange={(event) => setCustom(question.id, event.target.value, question.kind === "single_select")}
                        />
                      </span>
                    </label>
                  </div>
                )}
                {missing ? <p className={styles.validation} role="alert">{t("userInput.missing")}</p> : null}
              </section>
            );
          })}
        </div>

        <footer className={styles.footer}>
          <div className={styles.waiting}>
            {remainingSeconds === null ? t("userInput.waiting") : <>
              <strong role="timer" aria-live="off" data-urgent={remainingSeconds <= 10 || undefined}>{t("userInput.countdown", { seconds: remainingSeconds })}</strong>
              <span id={`user-input-timeout-${request.id}`}>{t("userInput.timeoutHint")}</span>
            </>}
          </div>
          <div className={styles.actions}>
            <button className={styles.secondary} type="button" onClick={cancel}>{t("userInput.skip")}</button>
            <button className={styles.primary} type="button" onClick={submit} aria-disabled={!complete}>
              {t("userInput.submit")}
              <span className={styles.shortcut}>Ctrl ↵</span>
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
