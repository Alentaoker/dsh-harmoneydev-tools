export const PIORA_DEFAULT_PROVIDER_ENV = "PIORA_DEFAULT_PROVIDER";
export const PIORA_DEFAULT_MODEL_ENV = "PIORA_DEFAULT_MODEL";
export const DEFAULT_PREFERRED_PROVIDER = "deepseek";

export interface ModelReference {
  provider: string;
  modelId: string;
}

export interface ModelIdentity {
  provider: string;
  id: string;
}

type Environment = Record<string, string | undefined>;

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function asReference(
  provider: string | null | undefined,
  modelId: string | null | undefined,
): ModelReference | undefined {
  const normalizedProvider = nonEmpty(provider);
  const normalizedModelId = nonEmpty(modelId);
  return normalizedProvider && normalizedModelId
    ? { provider: normalizedProvider, modelId: normalizedModelId }
    : undefined;
}

function findAvailableReference(
  models: readonly ModelIdentity[],
  reference: ModelReference | undefined,
): ModelReference | undefined {
  if (!reference) return undefined;
  const match = models.find((model) => (
    model.provider.toLocaleLowerCase() === reference.provider.toLocaleLowerCase()
      && model.id === reference.modelId
  ));
  return match ? { provider: match.provider, modelId: match.id } : undefined;
}

/** Read the non-secret desktop default packaged or supplied by the launcher. */
export function readPioraDefaultModel(environment: Environment): ModelReference | undefined {
  return asReference(
    environment[PIORA_DEFAULT_PROVIDER_ENV],
    environment[PIORA_DEFAULT_MODEL_ENV],
  );
}

/**
 * Resolve the default for a new desktop session.
 *
 * A valid explicit pi setting always wins. The desktop launcher can supply a
 * versioned default through PIORA_DEFAULT_PROVIDER / PIORA_DEFAULT_MODEL.
 * When neither is usable, the first available DeepSeek model is preferred.
 */
export function resolveDefaultModelPreference(options: {
  models: readonly ModelIdentity[];
  settingsProvider?: string | null;
  settingsModel?: string | null;
  environment: Environment;
  preferredProvider?: string;
}): ModelReference | undefined {
  const settingsDefault = findAvailableReference(
    options.models,
    asReference(options.settingsProvider, options.settingsModel),
  );
  if (settingsDefault) return settingsDefault;

  const desktopDefault = findAvailableReference(
    options.models,
    readPioraDefaultModel(options.environment),
  );
  if (desktopDefault) return desktopDefault;

  const preferredProvider = nonEmpty(options.preferredProvider)
    ?? DEFAULT_PREFERRED_PROVIDER;
  const preferred = options.models.find((model) => (
    model.provider.toLocaleLowerCase() === preferredProvider.toLocaleLowerCase()
  ));
  return preferred ? { provider: preferred.provider, modelId: preferred.id } : undefined;
}

/**
 * Move one provider to the front without mutating the input or reordering any
 * items within the preferred and remaining partitions.
 */
export function prioritizeProvider<T>(
  items: readonly T[],
  getProvider: (item: T) => string,
  preferredProvider = DEFAULT_PREFERRED_PROVIDER,
): T[] {
  const normalizedPreferred = preferredProvider.toLocaleLowerCase();
  const preferred: T[] = [];
  const remaining: T[] = [];
  for (const item of items) {
    const target = getProvider(item).toLocaleLowerCase() === normalizedPreferred
      ? preferred
      : remaining;
    target.push(item);
  }
  return [...preferred, ...remaining];
}
