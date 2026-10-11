"use client";

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import type { SessionEntry, SessionTreeNode } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import { AliIcon } from "./AliIcon";

interface Props {
  tree: SessionTreeNode[];
  activeLeafId: string | null;
  onLeafChange: (leafId: string | null) => void;
  /** When true, renders as a compact inline button for embedding in a top bar */
  inline?: boolean;
  /** When inline, use this ref's bounding rect to size/position the dropdown */
  containerRef?: React.RefObject<HTMLElement | null>;
  /** Controlled open state for inline mode */
  open?: boolean;
  /** Called when the button is clicked in inline mode */
  onToggle?: () => void;
  /** Whether a session is currently active (used to show appropriate empty reason) */
  hasSession?: boolean;
  /** When inline, render icon-only (no text label) to save horizontal space */
  compact?: boolean;
}

// Find the visible entry IDs on the path from root to activeLeafId.
function buildActivePath(nodes: SessionTreeNode[], targetId: string | null): Set<string> {
  if (!targetId) return new Set();
  const target = targetId;
  function search(nodes: SessionTreeNode[], path: string[]): string[] | null {
    for (const node of nodes) {
      const next = [...path, node.entry.id];
      if (node.entry.id === target || node.compressedEntryIds?.includes(target)) {
        return next;
      }
      const found = search(node.children, next);
      if (found) return found;
    }
    return null;
  }
  return new Set(search(nodes, []) ?? []);
}

// Compress a visible linear chain into the first branching/leaf node.
// Server-side compressed IDs also count as skipped nodes.
function compress(node: SessionTreeNode): { node: SessionTreeNode; skipped: number } {
  let current = node;
  let skipped = current.compressedEntryIds?.length ?? 0;
  while (current.children.length === 1) {
    current = current.children[0];
    skipped += 1 + (current.compressedEntryIds?.length ?? 0);
  }
  return { node: current, skipped };
}

function getLabel(entry: SessionEntry): string {
  if (entry.type === "message" && "message" in entry) {
    const msg = entry.message as { role: string; content: unknown };
    const content = msg.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join(" ");
    }
    if (text.length > 40) text = text.slice(0, 40) + "…";
    if (text) return text;
    if (msg.role === "assistant") return "[assistant]";
  }
  return entry.type;
}

// Does the tree have any branching at all?
function hasBranch(nodes: SessionTreeNode[]): boolean {
  for (const node of nodes) {
    if (node.children.length > 1) return true;
    if (hasBranch(node.children)) return true;
  }
  return false;
}

interface TreeNodeProps {
  node: SessionTreeNode;
  activePathIds: Set<string>;
  depth: number;
  isLast: boolean;
  parentLines: boolean[]; // whether ancestor at each depth has more siblings after
  onSelect: (id: string) => void;
}

function TreeNodeView({ node, activePathIds, depth, isLast, parentLines, onSelect }: TreeNodeProps) {
  const { node: rep, skipped } = compress(node);
  const isActive = activePathIds.has(rep.entry.id);
  const isOnPath = activePathIds.has(node.entry.id) || activePathIds.has(rep.entry.id);
  const label = getLabel(rep.entry);
  const role = rep.entry.type === "message" && "message" in rep.entry
    ? (rep.entry.message as { role: string }).role
    : null;

  return (
    <div>
      {/* This node row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: 24,
          cursor: "pointer",
        }}
        onClick={() => onSelect(rep.entry.id)}
      >
        {/* Indent guide lines */}
        {parentLines.map((hasLine, i) => (
          <div key={i} style={{ width: 16, flexShrink: 0, position: "relative", height: "100%", alignSelf: "stretch" }}>
            {hasLine && (
              <div style={{
                position: "absolute",
                left: 7,
                top: 0,
                bottom: 0,
                width: 1,
                background: "var(--border)",
              }} />
            )}
          </div>
        ))}

        {/* Branch connector */}
        <div style={{ width: 16, flexShrink: 0, position: "relative", height: "100%", alignSelf: "stretch" }}>
          {/* vertical line up (to parent) */}
          <div style={{
            position: "absolute",
            left: 7,
            top: 0,
            bottom: isLast ? "50%" : 0,
            width: 1,
            background: "var(--border)",
          }} />
          {/* horizontal line to node */}
          <div style={{
            position: "absolute",
            left: 7,
            top: "50%",
            width: 9,
            height: 1,
            background: "var(--border)",
          }} />
        </div>

        {/* Node dot */}
        <div style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          flexShrink: 0,
          background: isActive ? "var(--accent)" : isOnPath ? "var(--text-muted)" : "var(--border)",
          border: isActive ? "none" : "1px solid var(--text-dim)",
          marginRight: 6,
          transition: "background 0.12s",
        }} />

        {/* Role badge */}
        {role && (
          <span style={{
            fontSize: "var(--text-xs)",
            fontFamily: "var(--font-mono)",
            color: role === "user" ? "var(--accent)" : "var(--text-dim)",
            background: role === "user" ? "rgba(37,99,235,0.08)" : "var(--bg-hover)",
            border: `1px solid ${role === "user" ? "rgba(37,99,235,0.2)" : "var(--border)"}`,
            borderRadius: 3,
            padding: "0 4px",
            marginRight: 5,
            flexShrink: 0,
            lineHeight: "16px",
          }}>
            {role === "user" ? "U" : "A"}
          </span>
        )}

        {/* Skipped indicator */}
        {skipped > 0 && (
          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", marginRight: 5, flexShrink: 0 }}>
            +{skipped}
          </span>
        )}

        {/* Label */}
        <span style={{
          fontSize: "var(--text-xs)",
          color: isActive ? "var(--text)" : isOnPath ? "var(--text-muted)" : "var(--text-dim)",
          fontWeight: isActive ? 500 : 400,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
          minWidth: 0,
        }}>
          {label}
        </span>
      </div>

      {/* Children */}
      {rep.children.map((child, idx) => (
        <TreeNodeView
          key={child.entry.id}
          node={child}
          activePathIds={activePathIds}
          depth={depth + 1}
          isLast={idx === rep.children.length - 1}
          parentLines={[...parentLines, !isLast]}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

export function BranchNavigator({ tree, activeLeafId, onLeafChange, inline, containerRef, open: openProp, onToggle, hasSession, compact }: Props) {
  const { t } = useI18n();
  const [openInternal, setOpenInternal] = useState(false);
  const open = openProp !== undefined ? openProp : openInternal;
  const btnRef = useRef<HTMLButtonElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    if (!open || !inline) return;
    const anchor = btnRef.current;
    const boundary = containerRef?.current
      ?? (anchor?.offsetParent instanceof HTMLElement ? anchor.offsetParent : null);
    if (!anchor || !boundary) return;
    const update = () => {
      const anchorRect = anchor.getBoundingClientRect();
      const boundaryRect = boundary.getBoundingClientRect();
      const inset = 6;
      const width = Math.max(0, Math.min(380, boundaryRect.width - inset * 2, window.innerWidth - inset * 2));
      const leftInViewport = Math.min(
        Math.max(anchorRect.left, boundaryRect.left + inset),
        boundaryRect.right - width - inset,
      );
      setDropdownPos({
        top: boundaryRect.height + inset,
        left: leftInViewport - boundaryRect.left,
        width,
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(anchor);
    ro.observe(boundary);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [open, inline, containerRef]);

  const activePathIds = useMemo(
    () => buildActivePath(tree, activeLeafId),
    [tree, activeLeafId]
  );

  const handleSelect = useCallback((id: string) => {
    onLeafChange(id);
  }, [onLeafChange]);

  const noBranchReason = !hasSession
    ? t("i18n.noActiveSession")
    : !hasBranch(tree)
      ? t("i18n.noBranches")
      : null;

  // Find first meaningful node (skip pure linear prefix)
  const compressed = tree.length > 0 ? compress(tree[0]) : null;
  const firstNode = compressed?.node ?? null;
  const hasContent = !noBranchReason && firstNode && firstNode.children.length > 1;

  const branchIcon = (
    <AliIcon name="branches" size={14} style={{ color: hasContent ? "var(--accent)" : "var(--text-dim)" }} />
  );

  const chevron = (
    <AliIcon name="arrowdown" size={10} style={{ marginLeft: 2, color: "var(--text-dim)", transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
  );


  if (inline) {
    return (
      <div className="topbar-branch-control" style={{ height: "100%", display: "flex", alignItems: "stretch" }}>
        <button
          className="topbar-control"
          ref={btnRef}
          onClick={() => onToggle ? onToggle() : setOpenInternal((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: "100%",
            padding: "0 12px",
            background: open ? "var(--bg-selected)" : "none",
            border: "none",
            borderTop: open ? "2px solid var(--accent)" : "2px solid transparent",
            cursor: "pointer",
            color: open ? "var(--text)" : "var(--text-muted)",
            fontSize: "var(--text-xs)",
            whiteSpace: "nowrap",
            transition: "color 0.1s, background 0.1s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = open ? "var(--text)" : "var(--text-muted)"; }}
           title={t("i18n.branches")}
           aria-label={t("i18n.branches")}
          aria-pressed={open}
        >
          {branchIcon}
           {!compact && <span className="topbar-action-label">{t("i18n.branches")}</span>}
        </button>
        {open && dropdownPos && (
          <div className="app-floating-panel branch-floating-panel" style={{
            position: "absolute",
            top: dropdownPos.top,
            left: dropdownPos.left,
            width: dropdownPos.width,
            zIndex: 500,
          }}>
            <div className="soft-top-panel-header">
              <span className="soft-top-panel-icon" aria-hidden="true">{branchIcon}</span>
              <span className="soft-top-panel-heading">
                <span className="soft-top-panel-title">{t("i18n.branches")}</span>
                <span className="soft-top-panel-description">{t("i18n.branchesDescription")}</span>
              </span>
            </div>
            <div className="soft-top-panel-body">
              {hasContent && firstNode ? (
                <div className="branch-tree-scroll">
                  {firstNode.children.map((child, idx) => (
                    <TreeNodeView
                      key={child.entry.id}
                      node={child}
                      activePathIds={activePathIds}
                      depth={0}
                      isLast={idx === firstNode.children.length - 1}
                      parentLines={[]}
                      onSelect={handleSelect}
                    />
                  ))}
                </div>
              ) : (
                <div className="soft-top-panel-empty">
                  {noBranchReason}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ borderBottom: "1px solid var(--border)", background: "var(--bg)", flexShrink: 0, position: "relative" }}>
      {/* Header toggle */}
      <button
        onClick={() => setOpenInternal((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "5px 12px",
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--text-muted)",
          fontSize: "var(--text-xs)",
          textAlign: "left",
        }}
      >
        {branchIcon}
         <span style={{ color: "var(--text-muted)" }}>{t("i18n.branches")}</span>
        {chevron}
      </button>

      {/* Tree panel - overlay */}
      {open && (
        <div style={{
          position: "absolute",
          top: "100%",
          left: 0,
          right: 0,
          background: "var(--bg)",
          borderBottom: "1px solid var(--border)",
          boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
          zIndex: 100,
        }}>
          {hasContent && firstNode ? (
            <div style={{ padding: "4px 12px 8px 12px", maxHeight: 260, overflowY: "auto" }}>
              {firstNode.children.map((child, idx) => (
                <TreeNodeView
                  key={child.entry.id}
                  node={child}
                  activePathIds={activePathIds}
                  depth={0}
                  isLast={idx === firstNode.children.length - 1}
                  parentLines={[]}
                  onSelect={handleSelect}
                />
              ))}
            </div>
          ) : (
            <div style={{ padding: "10px 16px", fontSize: "var(--text-sm)", color: "var(--text-muted)", fontStyle: "italic" }}>
              {noBranchReason ?? t("i18n.noBranches")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
