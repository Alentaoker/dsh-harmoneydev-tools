"use client";

import { useCallback, useMemo, useState } from "react";
import { filterGuiCommands, GUI_COMMANDS, type Command, type CommandContext } from "@/lib/commands";

const RECENT_KEY = "piora-recent-commands-v1";

function loadRecent(): string[] {
  if (typeof window === "undefined") return [];
  try { const value = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]"); return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 10) : []; }
  catch { return []; }
}

export function useCommands(context: CommandContext, translate: (key: string) => string, shortcutLabels: Partial<Record<string, string>> = {}) {
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const commands = useMemo(() => {
    const recentOrder = new Map(recent.map((id, index) => [id, index]));
    return GUI_COMMANDS.map((item) => ({ ...item, shortcut: shortcutLabels[item.id] ?? item.shortcut }))
      .sort((a, b) => (recentOrder.get(a.id) ?? 999) - (recentOrder.get(b.id) ?? 999));
  }, [recent, shortcutLabels]);
  const search = useCallback((query: string) => filterGuiCommands(commands, query, (item) => translate(item.title)), [commands, translate]);
  const run = useCallback(async (item: Command, argument?: string) => {
    const enabled = item.enabled(context);
    if (enabled !== true) return;
    await item.run(context, argument);
    setRecent((current) => {
      const next = [item.id, ...current.filter((id) => id !== item.id)].slice(0, 10);
      window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      return next;
    });
  }, [context]);
  return { commands, search, run };
}
