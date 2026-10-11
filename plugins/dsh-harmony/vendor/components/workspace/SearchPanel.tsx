"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getFileName, joinFilePath } from "@/lib/file-paths";
import type { WorkspaceSearchMode, WorkspaceSearchResponse } from "@/lib/workspace-search";
import styles from "./WorkspacePanel.module.css";

interface Props {
  cwd: string | null;
  onOpenFile: (path: string, name: string, options?: { line?: number }) => void;
}

export interface SearchPanelHandle { focus: () => void; }

export const SearchPanel = forwardRef<SearchPanelHandle, Props>(function SearchPanel({ cwd, onOpenFile }, ref) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<WorkspaceSearchMode>("files");
  const [response, setResponse] = useState<WorkspaceSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);

  useEffect(() => {
    const normalized = query.trim();
    if (!cwd || !normalized) {
      setResponse(null);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      fetch(`/api/search?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(normalized)}&mode=${mode}`, {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (result) => {
          const data = await result.json() as WorkspaceSearchResponse & { error?: string };
          if (!result.ok) throw new Error(data.error || t("search.failed"));
          setResponse(data);
        })
        .catch((reason) => {
          if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [cwd, mode, query, t]);

  return <div className={styles.searchRoot}>
    <div className={styles.searchControls}>
      <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("search.placeholder")} aria-label={t("search.placeholder")} />
      <div className={styles.searchModes} role="radiogroup" aria-label={t("search.mode")}>
        {(["files", "content"] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={mode === value} onClick={() => setMode(value)}>{t(`search.${value}`)}</button>)}
      </div>
    </div>
    {!cwd ? <div className={styles.empty}>{t("workspace.selectProject")}</div>
      : error ? <div className={styles.error} role="alert">{error}</div>
        : !query.trim() ? <div className={styles.empty}>{t("search.hint")}</div>
          : loading && !response ? <div className={styles.empty}>{t("search.searching")}</div>
            : <div className={styles.searchResults} role="listbox" aria-label={t("search.results")}>
              {response?.results.map((result, index) => {
                const absolute = joinFilePath(cwd, result.path);
                return <button key={`${result.path}:${result.line ?? 0}:${index}`} type="button" role="option" aria-selected={false} onClick={() => onOpenFile(absolute, getFileName(result.path), result.line ? { line: result.line } : undefined)}>
                  <span className={styles.searchPath}>{result.path}{result.line ? `:${result.line}:${result.column ?? 1}` : ""}</span>
                  {result.preview !== undefined ? <span className={styles.searchPreview}>{result.preview || " "}</span> : null}
                </button>;
              })}
              {response && response.results.length === 0 ? <div className={styles.empty}>{t("search.noResults")}</div> : null}
              {response?.truncated || response?.timedOut ? <div className={styles.searchNotice}>{response.timedOut ? t("search.timedOut") : t("search.truncated")}</div> : null}
            </div>}
  </div>;
});
