"use client";

import type { Dispatch, RefObject, SetStateAction } from "react";
import { useI18n } from "@/hooks/useI18n";
import { AliIcon } from "../AliIcon";
import { FileExplorer, type FileExplorerHandle } from "../FileExplorer";
import { ToolbarIconButton } from "./SidebarPrimitives";

interface Props {
  selectedCwdProp?: string | null; selectedCwd: string | null;
  explorerOpen: boolean; setExplorerOpen: Dispatch<SetStateAction<boolean>>;
  changesCount: number; setChangesCount: Dispatch<SetStateAction<number>>;
  changesCollapsed: boolean; setChangesCollapsed: Dispatch<SetStateAction<boolean>>;
  explorerUploadBusy: boolean; setExplorerUploadBusy: Dispatch<SetStateAction<boolean>>;
  explorerRefreshDone: boolean; setExplorerRefreshDone: Dispatch<SetStateAction<boolean>>;
  explorerKey: number; setExplorerKey: Dispatch<SetStateAction<number>>;
  fileExplorerRef: RefObject<FileExplorerHandle | null>;
  explorerRefreshTimerRef: RefObject<ReturnType<typeof setTimeout> | null>;
  onExplorerRefresh?: () => void; selectedFilePath?: string | null;
  onOpenFile?: (filePath: string, fileName: string, options?: { sourceSessionId?: string | null; modeHint?: "diff" }) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
}
export function SidebarFileArea(props: Props) {
  const { t } = useI18n();
  const { selectedCwdProp, selectedCwd, explorerOpen, setExplorerOpen, changesCount, setChangesCount, changesCollapsed, setChangesCollapsed, explorerUploadBusy, setExplorerUploadBusy, explorerRefreshDone, setExplorerRefreshDone, explorerKey, setExplorerKey, fileExplorerRef, explorerRefreshTimerRef, onExplorerRefresh, selectedFilePath, onOpenFile, onAtMention, onAtMentions } = props;
  return <>
      {/* File Explorer section */}
      {(selectedCwdProp || selectedCwd) && (
        <div
          style={{
            borderTop: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            flex: explorerOpen ? "1 1 0" : "0 0 auto",
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
            <button
              onClick={() => setExplorerOpen((v) => !v)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                flex: 1,
                padding: "6px 10px",
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: "var(--text-xs)",
                fontWeight: 600,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                textAlign: "left",
              }}
            >
              <AliIcon name="chevron-right" size={14} strokeWidth={1.8} style={{ transform: explorerOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s" }} />
              {t("files.explorer")}
            </button>
            {explorerOpen && changesCount > 0 && (
              <ToolbarIconButton
                onClick={() => setChangesCollapsed((v) => !v)}
                title={t("sidebar.changedFiles", { count: changesCount })}
                ariaPressed={!changesCollapsed}
                color={changesCollapsed ? "var(--text-dim)" : "var(--accent)"}
                background={changesCollapsed ? "none" : "var(--bg-selected)"}
              >
                <AliIcon name="diff" size={13} />
              </ToolbarIconButton>
            )}
            {explorerOpen && (
              <ToolbarIconButton
                onClick={() => fileExplorerRef.current?.focusSearch()}
                title={t("files.searchShortcut")}
                color="var(--text-dim)"
              >
                <AliIcon name="search" size={13} />
              </ToolbarIconButton>
            )}
            {explorerOpen && (
              <ToolbarIconButton
                onClick={() => fileExplorerRef.current?.openUploadPicker()}
                disabled={explorerUploadBusy}
                title={t("sidebar.uploadFilesTitle")}
                color="var(--text-dim)"
              >
                <AliIcon name="upload" size={13} />
              </ToolbarIconButton>
            )}
            <ToolbarIconButton
              onClick={() => {
                if (onExplorerRefresh) onExplorerRefresh();
                else setExplorerKey((k) => k + 1);
                setExplorerRefreshDone(true);
                if (explorerRefreshTimerRef.current) clearTimeout(explorerRefreshTimerRef.current);
                explorerRefreshTimerRef.current = setTimeout(() => setExplorerRefreshDone(false), 2000);
              }}
              title={t("sidebar.refreshExplorer")}
              skipHover={explorerRefreshDone}
              color={explorerRefreshDone ? "#4ade80" : "var(--text-dim)"}
              background={explorerRefreshDone ? "rgba(74,222,128,0.18)" : "none"}
              marginRight={6}
            >
              {explorerRefreshDone ? (
                <AliIcon name="check" size={13} style={{ color: "#4ade80" }} />
              ) : (
                <AliIcon name="reload" size={13} />
              )}
            </ToolbarIconButton>
          </div>
          {explorerOpen && (
            <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
              <FileExplorer
                ref={fileExplorerRef}
                cwd={selectedCwd ?? selectedCwdProp!}
                selectedFilePath={selectedFilePath}
                onOpenFile={onOpenFile ?? (() => {})}
                refreshKey={explorerKey}
                onAtMention={onAtMention}
                onAtMentions={onAtMentions}
                onUploadBusyChange={setExplorerUploadBusy}
                changesCollapsed={changesCollapsed}
                onChangesCountChange={setChangesCount}
              />
            </div>
          )}
        </div>
      )}

  </>;
}
