"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { GitFileStatus } from "@/lib/git-types";
import { getReviewNavigationIndex } from "@/lib/review-keyboard";
import { getReviewListWindow, REVIEW_LIST_PAGE_SIZE } from "@/lib/review-progressive";
import { getFileIcon } from "../FileIcons";
import styles from "./WorkspacePanel.module.css";

export type ChangeGroup = "staged" | "unstaged" | "untracked";

export interface ChangeListItem {
  key: string;
  group: ChangeGroup;
  file: GitFileStatus;
}

interface Props {
  items: ChangeListItem[];
  repositoryRoot: string;
  selectedKey: string | null;
  busy: boolean;
  onSelect: (item: ChangeListItem) => void;
  onToggleStage: (item: ChangeListItem) => void;
}

const GROUPS: ChangeGroup[] = ["staged", "unstaged", "untracked"];

export function toReviewPath(filePath: string, repositoryRoot: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const root = repositoryRoot.replace(/\\/g, "/").replace(/\/$/, "");
  return normalized.toLocaleLowerCase().startsWith(`${root.toLocaleLowerCase()}/`)
    ? normalized.slice(root.length + 1) : normalized;
}

export function ChangeList({ items, repositoryRoot, selectedKey, busy, onSelect, onToggleStage }: Props) {
  const { t } = useI18n();
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const pendingFocusKey = useRef<string | null>(null);
  const orderedEntries = useMemo(() => GROUPS.flatMap((group) => {
    const groupItems = items.filter((item) => item.group === group);
    return groupItems.map((item, index) => ({ item, positionInGroup: index + 1, groupSize: groupItems.length }));
  }), [items]);
  const orderedItems = useMemo(() => orderedEntries.map((entry) => entry.item), [orderedEntries]);
  const selectedIndex = Math.max(0, orderedItems.findIndex((item) => item.key === selectedKey));
  const renderWindow = getReviewListWindow(orderedEntries.length, selectedIndex);
  const visibleEntries = orderedEntries.slice(renderWindow.startIndex, renderWindow.endIndex);
  const selectAndFocus = useCallback((item: ChangeListItem) => {
    pendingFocusKey.current = item.key;
    onSelect(item);
  }, [onSelect]);

  useEffect(() => {
    const pendingKey = pendingFocusKey.current;
    if (!pendingKey || pendingKey !== selectedKey) return;
    const row = rowRefs.current.get(pendingKey);
    if (!row) return;
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: "nearest" });
    pendingFocusKey.current = null;
  }, [renderWindow.endIndex, renderWindow.startIndex, selectedKey]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (!event.altKey || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
      const index = Math.max(0, orderedItems.findIndex((item) => item.key === selectedKey));
      const nextIndex = getReviewNavigationIndex(index, event.key, orderedItems.length);
      if (nextIndex === null || !orderedItems[nextIndex]) return;
      event.preventDefault();
      selectAndFocus(orderedItems[nextIndex]);
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [orderedItems, selectAndFocus, selectedKey]);

  const showWindowControls = renderWindow.before > 0 || renderWindow.after > 0;
  return <div className={styles.changeList}>
    {showWindowControls ? <div id="review-change-range" className={styles.changeRange} role="status" aria-live="polite">
      {t("review.changeRange", { start: renderWindow.startIndex + 1, end: renderWindow.endIndex, count: orderedEntries.length })}
    </div> : null}
    {renderWindow.before > 0 ? <button
      type="button"
      className={styles.changePageButton}
      onClick={() => selectAndFocus(orderedItems[renderWindow.startIndex - 1])}
    >{t("review.previousChanges", { count: Math.min(renderWindow.before, REVIEW_LIST_PAGE_SIZE) })}</button> : null}
    <div role="tree" aria-label={t("review.changesTree")} aria-describedby={showWindowControls ? "review-change-range" : undefined}>
    {GROUPS.map((group) => {
      const groupEntries = visibleEntries.filter((entry) => entry.item.group === group);
      if (groupEntries.length === 0) return null;
      const groupSize = groupEntries[0].groupSize;
      const titleId = `review-change-group-${group}`;
      return <section key={group} className={styles.changeGroup} role="group" aria-labelledby={titleId}>
        <div id={titleId} className={styles.groupTitle}>{t(`review.group.${group}`)}<span>{groupSize}</span></div>
        {groupEntries.map(({ item, positionInGroup }) => {
          const path = typeof item.file?.filePath === "string" ? item.file.filePath : "";
          const displayPath = toReviewPath(path, repositoryRoot);
          const name = displayPath.split("/").pop() ?? displayPath;
          const parent = displayPath.split("/").slice(0, -1).join("/");
          const parentLabel = compactParentPath(parent);
          return <div
            key={item.key}
            ref={(node) => { if (node) rowRefs.current.set(item.key, node); else rowRefs.current.delete(item.key); }}
            role="treeitem"
            aria-level={1}
            aria-posinset={positionInGroup}
            aria-setsize={groupSize}
            data-group={item.group}
            tabIndex={item.key === selectedKey ? 0 : -1}
            aria-selected={item.key === selectedKey}
            className={`${styles.changeRow} ${item.key === selectedKey ? styles.selected : ""}`}
            onClick={() => selectAndFocus(item)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.altKey) return;
              const index = orderedItems.findIndex((candidate) => candidate.key === item.key);
              const nextIndex = getReviewNavigationIndex(index, event.key, orderedItems.length);
              if (nextIndex !== null) {
                event.preventDefault();
                selectAndFocus(orderedItems[nextIndex]);
              } else if (event.key === " " || event.key === "Spacebar") {
                event.preventDefault();
                if (!busy) onToggleStage(item);
              } else if (event.key === "Enter") {
                event.preventDefault();
                selectAndFocus(item);
              }
            }}
          >
            <span className={styles.changeFileIcon} aria-hidden="true">{getFileIcon(name, 15)}</span>
            <input
              className={styles.changeCheckbox}
              type="checkbox"
              checked={item.group === "staged"}
              disabled={busy}
              aria-label={t(item.group === "staged" ? "review.unstageFile" : "review.stageFile", { name })}
              onClick={(event) => event.stopPropagation()}
              onChange={() => onToggleStage(item)}
            />
            <span className={styles.changeName} title={path}>{parentLabel ? <small>{parentLabel}/</small> : null}<b>{name}</b></span>
            <span className={styles.lineStats}>
              {(item.file.additions ?? 0) > 0 ? <span className={styles.additions}>+{item.file.additions}</span> : null}
              {(item.file.deletions ?? 0) > 0 ? <span className={styles.deletions}>−{item.file.deletions}</span> : null}
              {(item.file.additions ?? 0) === 0 && (item.file.deletions ?? 0) === 0 ? <span>—</span> : null}
            </span>
          </div>;
        })}
      </section>;
    })}
    </div>
    {renderWindow.after > 0 ? <button
      type="button"
      className={styles.changePageButton}
      onClick={() => selectAndFocus(orderedItems[renderWindow.endIndex])}
    >{t("review.nextChanges", { count: Math.min(renderWindow.after, REVIEW_LIST_PAGE_SIZE) })}</button> : null}
  </div>;
}

function compactParentPath(parent: string): string {
  const parts = parent.split("/").filter(Boolean);
  if (parts.length <= 2) return parts.join("/");
  return parts.slice(-2).join("/");
}
