export const PROMPT_MATERIAL_MARKER_PREFIX = "[[PIORA_PROMPT_MATERIALS_V1:";
export const PROMPT_MATERIAL_MARKER_SUFFIX = "]]";

export interface PromptMaterialReference {
  id: string;
}

export interface ResolvedPromptMaterial {
  id: string;
  name: string;
  path: string;
  byteLength: number;
  sha256: string;
  lineCount: number;
}

export interface PromptMaterialMarkerPayload {
  message: string;
  materials: ResolvedPromptMaterial[];
}

export function isPromptMaterialRuntimeMessage(content: unknown): content is string {
  return typeof content === "string" && content.startsWith(PROMPT_MATERIAL_MARKER_PREFIX);
}
