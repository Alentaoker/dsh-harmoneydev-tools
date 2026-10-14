"use client";

import { useBackground } from "@/hooks/useBackground";
import { useInterfaceTransparency } from "@/hooks/useInterfaceTransparency";

/** Mount once near the application root so saved backgrounds apply at startup. */
export function BackgroundBootstrap() {
  useBackground();
  useInterfaceTransparency();
  return null;
}
