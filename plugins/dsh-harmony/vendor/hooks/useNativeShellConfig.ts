"use client";

import { useEffect, useState } from "react";
import { shellRequest } from "@/lib/shell/client";
import type { NativeShellConfig } from "@/lib/shell/types";

export function useNativeShellConfig() {
  const [config, setConfig] = useState<NativeShellConfig | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let request = 0;
    const load = () => {
      const current = ++request;
      void shellRequest<NativeShellConfig>("native-settings", undefined, { signal: controller.signal })
        .then(value => { if (!controller.signal.aborted && current === request) { setConfig(value); setError(""); } })
        .catch(cause => { if (!controller.signal.aborted && current === request) setError(String(cause)); });
    };
    load();
    window.addEventListener("piora-native-shell-settings", load);
    return () => { controller.abort(); window.removeEventListener("piora-native-shell-settings", load); };
  }, []);
  return { config, error };
}
