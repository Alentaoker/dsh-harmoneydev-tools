// Generated before compilation, so server and browser use the same build identity.
export { APP_BRAND, APP_DISPLAY_NAME } from "./generated/brand.ts";
import { APP_DISPLAY_NAME } from "./generated/brand.ts";

/** Apply only to app-owned interface copy, never chat text or identifiers. */
export function brandText(copy: string): string {
  return copy.replaceAll("Piora", APP_DISPLAY_NAME).replaceAll("PIORA", APP_DISPLAY_NAME.toUpperCase());
}
