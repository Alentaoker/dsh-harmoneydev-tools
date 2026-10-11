import launch from "./templates/launch-and-verify.json";
import chinese from "./templates/chinese-input.json";
import list from "./templates/long-list.json";
import orientation from "./templates/orientation.json";
import voice from "./templates/push-to-talk.json";
import recovery from "./templates/safe-recovery.json";
import { HarmonyError } from "../errors";
import { validateHarmonyScenario } from "../scenario-executor";
import type { HarmonyScenarioStep } from "../types";
export const scenarioTemplates = [launch, chinese, list, orientation, voice, recovery];
export function bindScenarioTemplate(id: string, parameters: Record<string, unknown>): HarmonyScenarioStep[] {
  const template = scenarioTemplates.find(value => value.id === id);
  if (!template || !parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw new HarmonyError("INVALID_ARGUMENT", "Unknown scenario template or parameters");
  const names = Object.keys(template.parameters);
  if (Object.keys(parameters).some(key => !names.includes(key)) || names.some(key => parameters[key] === undefined)) throw new HarmonyError("INVALID_ARGUMENT", "Provide exactly the template's declared parameters");
  const bind = (value: unknown): unknown => {
    if (typeof value === "string") { const match = /^\{\{([A-Za-z0-9_]+)\}\}$/.exec(value); return match ? parameters[match[1]] : value; }
    if (Array.isArray(value)) return value.map(bind);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, bind(child)]));
    return value;
  };
  const steps = bind(template.steps) as HarmonyScenarioStep[];
  validateHarmonyScenario({ serial: "template-validation", leaseToken: "none", steps });
  return steps;
}
