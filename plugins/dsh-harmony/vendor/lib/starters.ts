import type { ProjectStarterSignals } from "./project-info";

export interface StarterSignals extends ProjectStarterSignals {
  hasUncommittedChanges: boolean;
  hasProject: boolean;
}

export interface Starter {
  id: "review" | "tests" | "architecture" | "dependencies" | "bug" | "explore";
  prompt: string;
  icon: string;
}

type Translate = (key: string) => string;

export function buildStarters(signals: StarterSignals, t: Translate): Starter[] {
  if (!signals.hasProject) {
    return [
      { id: "explore", prompt: t("starters.exploreDirectory"), icon: "folder-open" },
      { id: "bug", prompt: t("starters.findBug"), icon: "bug" },
    ];
  }
  const starters: Starter[] = [];
  if (signals.hasUncommittedChanges) starters.push({ id: "review", prompt: t("starters.reviewChanges"), icon: "diff" });
  if (signals.hasTests) starters.push({ id: "tests", prompt: t("starters.addTests"), icon: "check-circle" });
  if (signals.hasReadme) starters.push({ id: "architecture", prompt: t("starters.explainArchitecture"), icon: "project" });
  if (signals.hasPackageJson && signals.hasOutdatedDependencies) starters.push({ id: "dependencies", prompt: t("starters.upgradeDependencies"), icon: "sync" });
  starters.push({ id: "bug", prompt: t("starters.findBug"), icon: "bug" });
  return starters.slice(0, 4);
}
