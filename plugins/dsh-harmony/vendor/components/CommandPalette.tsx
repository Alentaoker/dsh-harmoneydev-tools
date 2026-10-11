"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useI18n } from "@/hooks/useI18n";
import { filterGuiCommandInvocationCandidates, getGuiCommandInvocationPrefix, parseGuiCommandInvocation, type Command, type CommandContext } from "@/lib/commands";
import styles from "./CommandPalette.module.css";

interface Props {
  open: boolean;
  commands: Command[];
  context: CommandContext;
  search: (query: string) => Command[];
  onRun: (command: Command, argument?: string) => void | Promise<void>;
  onClose: () => void;
}

const GROUPS = ["navigate", "session", "model", "panel", "settings", "git"] as const;

export function CommandPalette({ open, commands, context, search, onRun, onClose }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useFocusTrap(dialogRef, open, { initialFocus: inputRef, onEscape: onClose });
  const invocation = useMemo(() => parseGuiCommandInvocation(query, commands), [commands, query]);
  const filtered = useMemo(() => invocation?.command
    ? [invocation.command]
    : invocation
      ? filterGuiCommandInvocationCandidates(commands, invocation.token)
      : query ? search(query) : commands, [commands, invocation, query, search]);
  useEffect(() => { if (open) { setQuery(""); setActiveIndex(0); } }, [open]);
  useEffect(() => { if (activeIndex >= filtered.length) setActiveIndex(Math.max(0, filtered.length - 1)); }, [activeIndex, filtered.length]);
  if (!open) return null;
  const execute = async (item: Command) => {
    if (item.enabled(context) !== true) return;
    if (item.argument && invocation?.command !== item) {
      setQuery(getGuiCommandInvocationPrefix(item));
      return;
    }
    const argument = invocation?.command === item ? invocation.argument.trim() : "";
    if (item.argument?.required && !argument) {
      setQuery(getGuiCommandInvocationPrefix(item));
      return;
    }
    await onRun(item, argument || undefined);
    onClose();
  };
  const activeCommand = filtered[activeIndex] ?? null;
  const argumentCommand = invocation?.command ?? (activeCommand?.argument ? activeCommand : null);
  return <div className={styles.backdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={t("commands.palette")} ref={dialogRef} onKeyDown={(event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((current) => event.key === "ArrowDown" ? Math.min(filtered.length - 1, current + 1) : Math.max(0, current - 1)); }
      if (event.key === "Enter" && filtered[activeIndex]) { event.preventDefault(); void execute(filtered[activeIndex]); }
      if (event.key === "Tab" && activeCommand?.argument) { event.preventDefault(); setQuery(getGuiCommandInvocationPrefix(activeCommand) + (invocation?.command === activeCommand ? invocation.argument : "")); }
    }}>
      <input ref={inputRef} className={styles.input} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("commands.search")} aria-label={t("commands.search")} aria-describedby={argumentCommand ? "command-argument-hint" : undefined} />
      {argumentCommand?.argument ? <div className={styles.argumentHint} id="command-argument-hint"><code>{getGuiCommandInvocationPrefix(argumentCommand)}{t(argumentCommand.argument.placeholder)}</code><span>{t("commands.argumentHint")}</span></div> : null}
      <div className={styles.list}>{filtered.length ? GROUPS.map((group) => {
        const items = filtered.map((item, index) => ({ item, index })).filter(({ item }) => item.group === group);
        if (!items.length) return null;
        return <section key={group}><div className={styles.group}>{t(`commands.group.${group}`)}</div>{items.map(({ item, index }) => {
          const enabled = item.enabled(context); const reason = enabled === true ? null : t(enabled.reason);
          return <button key={item.id} type="button" className={styles.item} data-active={index === activeIndex} disabled={enabled !== true} onMouseEnter={() => setActiveIndex(index)} onClick={() => void execute(item)}><span className={styles.meta}><span>{item.id.startsWith("pi:") ? item.title : t(item.title)}</span>{item.source ? <span className={styles.reason}>{item.source}</span> : reason ? <span className={styles.reason}>{reason}</span> : null}</span>{item.shortcut ? <span className={styles.shortcut}>{item.shortcut}</span> : null}</button>;
        })}</section>;
      }) : <div className={styles.empty}>{t("commands.empty")}</div>}</div>
    </div>
  </div>;
}
