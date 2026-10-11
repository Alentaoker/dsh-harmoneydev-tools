/** Quality describes the observation, never the success of a business action. */
export interface HarmonyObservationQuality {
  treeStatus: "valid" | "partial" | "unavailable" | "parse-error";
  scopeComplete: boolean;
  scope?: "active-windows" | "unknown";
  appId?: string;
  windowId?: string;
}
