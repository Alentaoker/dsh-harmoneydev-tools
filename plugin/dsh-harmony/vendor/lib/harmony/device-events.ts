type Listener = (event: MessageEvent) => void;
const listeners = new Set<Listener>();
let source: EventSource | undefined;

/** One metadata stream per browser window, independent of conversation views. */
export function subscribeDeviceEvents(listener: Listener) {
  listeners.add(listener);
  if (!source) {
    source = new EventSource('/api/harmony/events');
    source.onmessage = event => {
      for (const subscriber of [...listeners]) { try { subscriber(event); } catch {} }
    };
    // Device polling is the recovery path; EventSource handles reconnection.
    source.onerror = () => {};
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    listeners.delete(listener);
    if (!listeners.size) {
      source?.close();
      source = undefined;
    }
  };
}
