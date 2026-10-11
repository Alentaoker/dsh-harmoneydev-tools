import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { noStoreJson, requireHarmonyAccess } from "../_shared";

export const dynamic = "force-dynamic";

declare global {
  var __pioraHarmonyVisionModelRuntime: Promise<ModelRuntime> | undefined;
}

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request);
  if (denied) return denied;
  try {
    const runtime = await (globalThis.__pioraHarmonyVisionModelRuntime ??= ModelRuntime.create());
    const error = runtime.getError();
    const models = runtime.getModels()
      .filter((model) => model.input.includes("image") && runtime.hasConfiguredAuth(model.provider))
      .map((model) => ({ provider: model.provider, modelId: model.id, name: model.name }));
    return noStoreJson({ models, ...(error ? { error } : {}) });
  } catch (error) {
    return noStoreJson({ models: [], error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
