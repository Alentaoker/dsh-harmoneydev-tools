"use client";

import { parseAnsiLine, stripAnsi } from "@/lib/ansi";
import type { ExtensionStatusItem } from "@/lib/types";
import { AliIcon } from "./AliIcon";

export function sanitizeExtensionStatusText(text: string): string {
  if (typeof text !== "string") return "";
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

export function formatExtensionStatusLine(statuses: ExtensionStatusItem[]): string {
  if (!Array.isArray(statuses)) return "";
  return [...statuses]
    .sort((a, b) => String(a?.key ?? "").localeCompare(String(b?.key ?? "")))
    .map(({ text }) => sanitizeExtensionStatusText(text))
    .join(" ");
}

export function ExtensionStatusBar({ statuses }: { statuses: ExtensionStatusItem[] }) {
  if (!Array.isArray(statuses) || statuses.length === 0) return null;

  const statusLine = formatExtensionStatusLine(statuses);
  const plainStatusLine = stripAnsi(statusLine);

  return (
    <div
      className="extension-status-control"
      role="status"
      tabIndex={0}
      aria-label={plainStatusLine}
    >
      <AliIcon name="api" size={15} aria-hidden="true" />
      <span className="extension-status-dot" aria-hidden="true" />
      <span className="extension-status-tooltip" role="tooltip">
        <strong>工具状态</strong>
        <span className="extension-status-line">
          {parseAnsiLine(statusLine).map((segment, index) => (
            <span key={index} style={segment.style}>{segment.text}</span>
          ))}
        </span>
      </span>
    </div>
  );
}
