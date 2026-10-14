declare global {
  var __pioraTeamBootstrapPromise: Promise<void> | undefined;
}

export function bootstrapTeamRuntime(): Promise<void> {
  return globalThis.__pioraTeamBootstrapPromise ??= import("./team-coordinator-service")
    .then(({ getTeamCoordinatorService }) => getTeamCoordinatorService().recoverAll())
    .catch((error) => {
    globalThis.__pioraTeamBootstrapPromise = undefined;
    throw error;
  });
}

export function resetTeamBootstrapForTests(): void {
  globalThis.__pioraTeamBootstrapPromise = undefined;
}
