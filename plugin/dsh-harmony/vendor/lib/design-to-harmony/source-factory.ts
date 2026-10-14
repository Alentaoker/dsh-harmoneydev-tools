import { readFigmaAccessToken } from "./credential-store";
import { DesignToHarmonyError } from "./errors";
import { FigmaSourceAdapter } from "./figma-adapter";
import { OctoSourceAdapter } from "./octo-adapter";
import type { DesignSourceAdapter } from "./source-adapter";
import type { DesignSourceRef } from "./types";

export function createDesignSourceAdapter(source: DesignSourceRef): DesignSourceAdapter {
  if (source.provider === "figma") return new FigmaSourceAdapter({ token: readFigmaAccessToken() });
  if (source.provider === "octo") return new OctoSourceAdapter();
  throw new DesignToHarmonyError("INVALID_ARGUMENT", "Unsupported design source", { status: 400, stage: "source" });
}
