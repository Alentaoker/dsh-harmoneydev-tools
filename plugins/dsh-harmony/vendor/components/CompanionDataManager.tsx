"use client";

import { useMemo, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import Image from "next/image";
import { useI18n } from "@/hooks/useI18n";
import {
  MAX_COMPANION_IMAGE_BYTES,
  MAX_COMPANION_LIBRARY_ITEMS,
  MAX_COMPANION_PHRASES,
  MAX_COMPANION_TODOS,
  createCompanionId,
  type CompanionLibraryKind,
  type CompanionPreferences,
} from "@/lib/companion-store";
import { AliIcon } from "./AliIcon";
import { JsonWorkbench } from "./JsonWorkbench";
import styles from "./CompanionDataManager.module.css";

type ManagerTab = "tasks" | "library" | "phrases";

interface Props {
  preferences: CompanionPreferences;
  setPreferences: Dispatch<SetStateAction<CompanionPreferences>>;
  canSendPhrase?: boolean;
  onSendPhrase?: (text: string) => boolean;
  compact?: boolean;
}

const LIBRARY_KINDS: CompanionLibraryKind[] = ["note", "code", "command", "image"];
const SAFE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function CompanionDataManager({ preferences, setPreferences, canSendPhrase = false, onSendPhrase, compact = false }: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<ManagerTab>("tasks");
  const [taskText, setTaskText] = useState("");
  const [taskProject, setTaskProject] = useState("");
  const [phraseLabel, setPhraseLabel] = useState("");
  const [phraseText, setPhraseText] = useState("");
  const [editingPhraseId, setEditingPhraseId] = useState<string | null>(null);
  const [sendNotice, setSendNotice] = useState("");
  const [libraryKind, setLibraryKind] = useState<CompanionLibraryKind>("note");
  const [libraryTitle, setLibraryTitle] = useState("");
  const [libraryContent, setLibraryContent] = useState("");
  const [libraryLanguage, setLibraryLanguage] = useState("");
  const [librarySearch, setLibrarySearch] = useState("");
  const [libraryError, setLibraryError] = useState("");
  const [libraryView, setLibraryView] = useState<"library" | "json">("library");
  const imageInputRef = useRef<HTMLInputElement>(null);

  const incompleteTasks = preferences.todos.filter((task) => !task.completed).length;
  const visibleLibrary = useMemo(() => {
    const query = librarySearch.trim().toLocaleLowerCase();
    return [...preferences.library]
      .filter((item) => !query || `${item.title}\n${item.kind}\n${item.content}`.toLocaleLowerCase().includes(query))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  }, [librarySearch, preferences.library]);

  const addTask = (event: FormEvent) => {
    event.preventDefault();
    const text = taskText.trim().slice(0, 240);
    const project = taskProject.trim().slice(0, 160);
    if (!text || preferences.todos.length >= MAX_COMPANION_TODOS) return;
    const now = Date.now();
    setPreferences((current) => ({
      ...current,
      todos: [...current.todos, {
        id: createCompanionId("todo"), text, completed: false, progress: 0,
        ...(project ? { project } : {}), createdAt: now, updatedAt: now,
      }],
    }));
    setTaskText("");
  };

  const updateTask = (id: string, patch: { completed?: boolean; progress?: number }) => {
    setPreferences((current) => ({
      ...current,
      todos: current.todos.map((task) => {
        if (task.id !== id) return task;
        const completed = patch.completed ?? task.completed;
        const progress = completed ? 100 : Math.max(0, Math.min(99, patch.progress ?? (task.progress === 100 ? 90 : task.progress)));
        return { ...task, completed, progress, updatedAt: Date.now() };
      }),
    }));
  };

  const savePhrase = (event: FormEvent) => {
    event.preventDefault();
    const label = phraseLabel.trim().slice(0, 40);
    const text = phraseText.trim().slice(0, 2_000);
    if (!label || !text) return;
    setPreferences((current) => {
      if (editingPhraseId) {
        return { ...current, phrases: current.phrases.map((phrase) => phrase.id === editingPhraseId ? { ...phrase, label, text } : phrase) };
      }
      if (current.phrases.length >= MAX_COMPANION_PHRASES) return current;
      return { ...current, phrases: [...current.phrases, { id: createCompanionId("phrase"), label, text }] };
    });
    setPhraseLabel("");
    setPhraseText("");
    setEditingPhraseId(null);
  };

  const saveLibraryItem = (event: FormEvent) => {
    event.preventDefault();
    const title = libraryTitle.trim().slice(0, 120);
    const content = libraryContent.trim().slice(0, libraryKind === "image" ? MAX_COMPANION_IMAGE_BYTES * 2 : 40_000);
    if (!title || !content || preferences.library.length >= MAX_COMPANION_LIBRARY_ITEMS) return;
    const now = Date.now();
    setPreferences((current) => ({
      ...current,
      library: [...current.library, {
        id: createCompanionId("library"), kind: libraryKind, title, content,
        ...(libraryLanguage.trim() ? { language: libraryLanguage.trim().slice(0, 40) } : {}),
        pinned: false, createdAt: now, updatedAt: now,
      }],
    }));
    setLibraryTitle("");
    setLibraryContent("");
    setLibraryLanguage("");
    setLibraryError("");
  };

  const loadImage = (file: File | undefined) => {
    if (!file) return;
    if (!SAFE_IMAGE_TYPES.has(file.type) || file.size > MAX_COMPANION_IMAGE_BYTES) {
      setLibraryError(t("companion.library.imageTooLarge"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      setLibraryKind("image");
      setLibraryTitle((current) => current || file.name.replace(/\.[^.]+$/, "").slice(0, 120));
      setLibraryContent(reader.result);
      setLibraryError("");
    };
    reader.onerror = () => setLibraryError(t("companion.library.imageReadFailed"));
    reader.readAsDataURL(file);
  };

  const copyLibraryItem = async (content: string, kind: CompanionLibraryKind) => {
    if (kind === "image") return;
    await navigator.clipboard.writeText(content);
    setSendNotice(t("companion.library.copied"));
    window.setTimeout(() => setSendNotice(""), 1_800);
  };

  const saveJsonResult = (result: { content: string; language: string; title: string }) => {
    if (preferences.library.length >= MAX_COMPANION_LIBRARY_ITEMS) return false;
    const now = Date.now();
    setPreferences((current) => ({
      ...current,
      library: [...current.library, {
        id: createCompanionId("library"), kind: "code", title: result.title,
        content: result.content, language: result.language, pinned: false, createdAt: now, updatedAt: now,
      }],
    }));
    return true;
  };

  return (
    <section className={styles.manager} data-compact={compact ? "true" : "false"} aria-label={t("companion.workspaceTitle")}>
      <div className={styles.metrics}>
        <span><strong>{incompleteTasks}</strong>{t("companion.metrics.tasks")}</span>
        <span><strong>{preferences.library.length}</strong>{t("companion.metrics.library")}</span>
        <span><strong>{preferences.todos.filter((task) => task.completed).length}</strong>{t("companion.metrics.completed")}</span>
      </div>
      <div className={styles.tabs} role="tablist" aria-label={t("companion.sections")}>
        {(["tasks", "library", "phrases"] as const).map((item) => (
          <button key={item} type="button" role="tab" aria-selected={tab === item} onClick={() => setTab(item)}>
            {t(`companion.tab.${item}`)}
          </button>
        ))}
      </div>

      {tab === "tasks" ? (
        <div className={styles.panel} role="tabpanel">
          <form className={styles.addTaskForm} onSubmit={addTask}>
            <input value={taskText} maxLength={240} onChange={(event) => setTaskText(event.target.value)} placeholder={t("companion.todoPlaceholder")} aria-label={t("companion.todoPlaceholder")} />
            <input value={taskProject} maxLength={160} onChange={(event) => setTaskProject(event.target.value)} placeholder={t("companion.taskProjectPlaceholder")} aria-label={t("companion.taskProjectPlaceholder")} />
            <button type="submit" disabled={!taskText.trim() || preferences.todos.length >= MAX_COMPANION_TODOS}>{t("companion.add")}</button>
          </form>
          {preferences.todos.length === 0 ? <div className={styles.empty}>{t("companion.noTodos")}</div> : (
            <ul className={styles.taskList}>
              {[...preferences.todos].sort((a, b) => Number(a.completed) - Number(b.completed) || b.updatedAt - a.updatedAt).map((task) => (
                <li key={task.id} data-completed={task.completed ? "true" : "false"}>
                  <input type="checkbox" checked={task.completed} onChange={(event) => updateTask(task.id, { completed: event.target.checked })} aria-label={t("companion.toggleTodo", { todo: task.text })} />
                  <div className={styles.taskBody}>
                    <div className={styles.taskHeading}><span>{task.text}</span><strong>{task.progress}%</strong></div>
                    {task.project ? <small>{task.project}</small> : null}
                    <input className={styles.range} type="range" min="0" max="100" step="5" value={task.progress} onChange={(event) => updateTask(task.id, { progress: Number(event.target.value), completed: Number(event.target.value) >= 100 })} aria-label={t("companion.taskProgress", { task: task.text })} />
                  </div>
                  <button className={styles.iconButton} type="button" onClick={() => setPreferences((current) => ({ ...current, todos: current.todos.filter((item) => item.id !== task.id) }))} aria-label={t("companion.removeTodo", { todo: task.text })}><AliIcon name="close" size={12} /></button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {tab === "library" ? (
        <div className={styles.panel} role="tabpanel">
          <div className={styles.libraryModes} role="tablist" aria-label={t("companion.json.libraryModes")}>
            <button type="button" role="tab" aria-selected={libraryView === "library"} onClick={() => setLibraryView("library")}>{t("companion.json.libraryView")}</button>
            <button type="button" role="tab" aria-selected={libraryView === "json"} onClick={() => setLibraryView("json")}>{t("companion.json.workbenchView")}</button>
          </div>
          {libraryView === "json" ? (
            <JsonWorkbench compact={compact} library={preferences.library} onSaveResult={saveJsonResult} />
          ) : <>
            <div className={styles.libraryToolbar}>
            <input value={librarySearch} onChange={(event) => setLibrarySearch(event.target.value)} placeholder={t("companion.library.search")} aria-label={t("companion.library.search")} />
            <button type="button" onClick={() => imageInputRef.current?.click()}><AliIcon name="attachment" size={13} />{t("companion.library.addImage")}</button>
            <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(event) => loadImage(event.target.files?.[0])} />
          </div>
          <form className={styles.libraryForm} onSubmit={saveLibraryItem}>
            <select value={libraryKind} onChange={(event) => { setLibraryKind(event.target.value as CompanionLibraryKind); setLibraryContent(""); }} aria-label={t("companion.library.type")}>
              {LIBRARY_KINDS.map((kind) => <option key={kind} value={kind}>{t(`companion.library.kind.${kind}`)}</option>)}
            </select>
            <input value={libraryTitle} maxLength={120} onChange={(event) => setLibraryTitle(event.target.value)} placeholder={t("companion.library.titlePlaceholder")} aria-label={t("companion.library.titlePlaceholder")} />
            {(libraryKind === "code" || libraryKind === "command") ? <input value={libraryLanguage} maxLength={40} onChange={(event) => setLibraryLanguage(event.target.value)} placeholder={t("companion.library.languagePlaceholder")} aria-label={t("companion.library.languagePlaceholder")} /> : null}
            {libraryKind === "image" ? (
              libraryContent ? <div className={styles.pendingImage}><Image src={libraryContent} alt="" width={640} height={360} unoptimized /></div> : <button className={styles.imagePicker} type="button" onClick={() => imageInputRef.current?.click()}>{t("companion.library.chooseImage")}</button>
            ) : (
              <textarea value={libraryContent} maxLength={40_000} onChange={(event) => setLibraryContent(event.target.value)} placeholder={t(`companion.library.contentPlaceholder.${libraryKind}`)} aria-label={t(`companion.library.contentPlaceholder.${libraryKind}`)} />
            )}
            <button type="submit" disabled={!libraryTitle.trim() || !libraryContent.trim() || preferences.library.length >= MAX_COMPANION_LIBRARY_ITEMS}>{t("companion.library.save")}</button>
          </form>
          {libraryError ? <div className={styles.error} role="alert">{libraryError}</div> : null}
          {visibleLibrary.length === 0 ? <div className={styles.empty}>{t("companion.library.empty")}</div> : (
            <ul className={styles.libraryList}>
              {visibleLibrary.map((item) => (
                <li key={item.id}>
                  <div className={styles.libraryHeading}>
                    <span className={styles.kindBadge}>{t(`companion.library.kind.${item.kind}`)}</span>
                    <strong>{item.title}</strong>
                    <button className={styles.iconButton} type="button" data-pinned={item.pinned ? "true" : "false"} onClick={() => setPreferences((current) => ({ ...current, library: current.library.map((entry) => entry.id === item.id ? { ...entry, pinned: !entry.pinned, updatedAt: Date.now() } : entry) }))} aria-label={t("companion.library.pin")}><AliIcon name="pushpin" size={12} /></button>
                    {item.kind !== "image" ? <button className={styles.iconButton} type="button" onClick={() => { void copyLibraryItem(item.content, item.kind); }} aria-label={t("companion.library.copy")}><AliIcon name="copy" size={12} /></button> : null}
                    <button className={styles.iconButton} type="button" onClick={() => setPreferences((current) => ({ ...current, library: current.library.filter((entry) => entry.id !== item.id) }))} aria-label={t("companion.library.remove")}><AliIcon name="close" size={12} /></button>
                  </div>
                  {item.kind === "image" ? <div className={styles.imagePreview}><Image src={item.content} alt={item.title} width={640} height={360} unoptimized /></div> : <pre>{item.content}</pre>}
                </li>
              ))}
            </ul>
          )}
          </>}
        </div>
      ) : null}

      {tab === "phrases" ? (
        <div className={styles.panel} role="tabpanel">
          <div className={styles.notice}>{canSendPhrase ? t("companion.oneClickReady") : t("companion.oneClickBusy")}<span aria-live="polite">{sendNotice}</span></div>
          <form className={styles.phraseForm} onSubmit={savePhrase}>
            <input value={phraseLabel} maxLength={40} onChange={(event) => setPhraseLabel(event.target.value)} placeholder={t("companion.phraseLabelPlaceholder")} aria-label={t("companion.phraseLabelPlaceholder")} />
            <input value={phraseText} maxLength={2_000} onChange={(event) => setPhraseText(event.target.value)} placeholder={t("companion.phraseTextPlaceholder")} aria-label={t("companion.phraseTextPlaceholder")} />
            <button type="submit" disabled={!phraseLabel.trim() || !phraseText.trim()}>{editingPhraseId ? t("companion.save") : t("companion.add")}</button>
          </form>
          {preferences.phrases.length === 0 ? <div className={styles.empty}>{t("companion.noPhrases")}</div> : (
            <ul className={styles.phraseList}>
              {preferences.phrases.map((phrase) => (
                <li key={phrase.id}>
                  <button type="button" disabled={!canSendPhrase} title={phrase.text} onClick={() => {
                    const sent = canSendPhrase && onSendPhrase?.(phrase.text);
                    setSendNotice(sent ? t("companion.sent") : t("companion.sendUnavailable"));
                    window.setTimeout(() => setSendNotice(""), 1_800);
                  }}>{phrase.label}</button>
                  <button className={styles.iconButton} type="button" onClick={() => { setEditingPhraseId(phrase.id); setPhraseLabel(phrase.label); setPhraseText(phrase.text); }} aria-label={t("companion.edit")}><AliIcon name="edit" size={12} /></button>
                  <button className={styles.iconButton} type="button" onClick={() => setPreferences((current) => ({ ...current, phrases: current.phrases.filter((item) => item.id !== phrase.id) }))} aria-label={t("companion.removePhrase", { phrase: phrase.label })}><AliIcon name="close" size={12} /></button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
