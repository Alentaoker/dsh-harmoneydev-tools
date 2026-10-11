import type {
  DesignAssetRequest,
  DesignAssetResult,
  DesignDocumentSummary,
  DesignImageFillResult,
  DesignReferenceRender,
  DesignSourceNodePayload,
  DesignSourceRef,
  DesignSourceVersion,
  DesignVariableCatalog,
} from "./types";

export interface DesignSourceAdapter {
  getDocumentSummary(ref: DesignSourceRef, signal?: AbortSignal): Promise<DesignDocumentSummary>;
  getNodes(ref: DesignSourceRef, nodeIds: string[], signal?: AbortSignal, versionId?: string): Promise<DesignSourceNodePayload[]>;
  getVariables(ref: DesignSourceRef, signal?: AbortSignal): Promise<DesignVariableCatalog>;
  exportAssets(ref: DesignSourceRef, requests: DesignAssetRequest[], signal?: AbortSignal): Promise<DesignAssetResult[]>;
  renderReference(ref: DesignSourceRef, nodeIds: string[], signal?: AbortSignal): Promise<DesignReferenceRender[]>;
  getImageFills?(ref: DesignSourceRef, signal?: AbortSignal): Promise<DesignImageFillResult[]>;
  getVersion(ref: DesignSourceRef, signal?: AbortSignal): Promise<DesignSourceVersion>;
}
