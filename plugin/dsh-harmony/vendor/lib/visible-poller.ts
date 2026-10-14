/** One request at a time; hidden surfaces retain data without doing background work. */
export function startVisiblePolling(options: {
  poll: (signal: AbortSignal) => Promise<void>;
  intervalMs: number;
  isVisible: () => boolean;
  subscribe: (changed: () => void) => () => void;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let stopped = false;
  let refreshRequested = false;
  const clearTimer = () => { clearTimeout(timer); timer = undefined; };
  const refresh = () => {
    clearTimer();
    if (stopped || !options.isVisible()) return;
    refreshRequested = true;
    if (controller) return;
    refreshRequested = false;
    const request = new AbortController();
    controller = request;
    void Promise.resolve().then(() => {
      if (!request.signal.aborted) return options.poll(request.signal);
    }).catch(() => {
      // A transient failure is retried on the next visible tick.
    }).finally(() => {
      controller = undefined;
      if (stopped || !options.isVisible()) return;
      timer = setTimeout(refresh, refreshRequested ? 0 : options.intervalMs);
    });
  };
  const unsubscribe = options.subscribe(() => {
    clearTimer();
    if (options.isVisible()) refresh();
    else { refreshRequested = false; controller?.abort(); }
  });
  refresh();
  return {
    refresh,
    stop() { stopped = true; clearTimer(); controller?.abort(); unsubscribe(); },
  };
}

export function pollVisibleDocument(poll: (signal: AbortSignal) => Promise<void>, intervalMs: number) {
  return startVisiblePolling({
    poll, intervalMs, isVisible: () => document.visibilityState === "visible",
    subscribe(changed) {
      document.addEventListener("visibilitychange", changed);
      window.addEventListener("online", changed);
      return () => {
        document.removeEventListener("visibilitychange", changed);
        window.removeEventListener("online", changed);
      };
    },
  });
}
