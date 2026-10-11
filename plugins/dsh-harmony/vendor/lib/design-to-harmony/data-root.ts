import { join, resolve } from "node:path";
import { getRuntimeAgentDataDirectory } from "../runtime-home";

export function designToHarmonyDataRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const desktopData = environment.PIORA_DESKTOP_DATA_DIR?.trim();
  return desktopData
    ? join(resolve(desktopData), "design-to-harmony")
    : join(getRuntimeAgentDataDirectory(environment), "piora", "design-to-harmony");
}
