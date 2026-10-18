"use client";

import "@dsh-e2e-workbench-css";
import { LogWorkbench } from "@dsh-e2e-workbench";

/**
 * Session logs inside the shared log workbench.
 *
 * This is deliberately the real dshE2E workbench, not a second viewer: import,
 * drag-and-drop, delete/restore, rename, package parsing, pagination, app and
 * TAG filters and the AI analysis drafts all stay in one implementation. Log
 * storage, parsing and reports therefore remain owned by dshE2E and no file is
 * copied or migrated.
 *
 * The paired source is resolved at build time (see scripts/build.mjs); a build
 * without it renders an explicit pairing notice instead of a reduced viewer.
 * dshE2E scopes its styles under `.de2e`, which this wrapper provides.
 */
export function SessionLogPane({ active, sessionId, focusFileId, onFocusConsumed, onDraft }: {
  active: boolean;
  sessionId?: string;
  focusFileId?: string;
  /** The caller clears its request once the workbench has honoured it. */
  onFocusConsumed?: () => void;
  onDraft?: (text: string) => void;
}) {
  return <div className="de2e" data-session-log-pane="">
    <LogWorkbench visible={active} sessionId={sessionId} openFileId={focusFileId} onOpenFileConsumed={onFocusConsumed} onDraft={onDraft} />
  </div>;
}
