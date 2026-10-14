"use client";

import { useEffect } from "react";

async function removeDesktopPwaArtifacts(): Promise<void> {
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.allSettled(registrations.map((registration) => registration.unregister()));

  if (!("caches" in window)) return;
  const cacheKeys = await window.caches.keys();
  await Promise.allSettled(
    cacheKeys
      .filter((key) => key.startsWith("piora-"))
      .map((key) => window.caches.delete(key)),
  );
}

export function PwaRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) {
      return;
    }

    // Electron already bundles the complete application and keeps its renderer
    // partition between releases. A browser service worker adds no offline
    // value there, but can retain a previous Next.js asset graph after an
    // upgrade. Remove legacy registrations and never create a new one.
    if (window.piDesktop) {
      void removeDesktopPwaArtifacts().catch((error: unknown) => {
        console.error("Failed to remove obsolete desktop PWA caches:", error);
      });
      return;
    }

    const register = () => {
      const appVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
      const scriptUrl = `/sw.js?v=${encodeURIComponent(appVersion)}`;

      void navigator.serviceWorker.register(scriptUrl, {
        scope: "/",
        updateViaCache: "none",
      }).catch((error: unknown) => {
        console.error("Failed to register the Piora service worker:", error);
      });
    };

    if (document.readyState === "complete") {
      register();
      return;
    }

    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
