export type DesignSourceProvider = "figma" | "octo";

export type DesignSourceTransport = "link" | "file";

export type DesignNodeType =
  | "DOCUMENT"
  | "CANVAS"
  | "SECTION"
  | "FRAME"
  | "GROUP"
  | "COMPONENT"
  | "COMPONENT_SET"
  | "INSTANCE"
  | "TEXT"
  | "VECTOR"
  | "RECTANGLE"
  | "ELLIPSE"
  | "LINE"
  | "STAR"
  | "POLYGON"
  | "BOOLEAN_OPERATION"
  | "SLICE"
  | "STAMP"
  | "HIGHLIGHT"
  | "WASHI_TAPE"
  | "SHAPE_WITH_TEXT"
  | "CODE_BLOCK"
  | "CONNECTOR"
  | "WIDGET"
  | "EMBED"
  | "LINK_UNFURL"
  | "MEDIA"
  | "UNKNOWN";

export interface DesignSourceRef {
  provider: DesignSourceProvider;
  fileKey: string;
  nodeId?: string;
  url: string;
  displayName?: string;
  transport?: DesignSourceTransport;
  originalFileName?: string;
}

export interface DesignSourceVersion {
  id: string;
  lastModified: string;
}

export interface DesignTreeNodeSummary {
  id: string;
  name: string;
  type: DesignNodeType;
  visible: boolean;
  childCount: number;
  children: DesignTreeNodeSummary[];
}

export interface DesignFlowSummary {
  id: string;
  name: string;
  nodeId: string;
  pageId: string;
}

export interface DesignComponentSummary {
  nodeId: string;
  key?: string;
  name: string;
  description?: string;
  componentSetId?: string;
}

export interface DesignStyleSummary {
  nodeId: string;
  key?: string;
  name: string;
  styleType?: string;
  description?: string;
}

export interface DesignVariableCollectionSummary {
  id: string;
  key?: string;
  name: string;
  modes: Array<{ id: string; name: string }>;
  variableIds: string[];
}

export interface DesignVariableSummary {
  id: string;
  key?: string;
  name: string;
  collectionId: string;
  resolvedType: "BOOLEAN" | "FLOAT" | "STRING" | "COLOR" | "UNKNOWN";
  remote: boolean;
  description?: string;
}

export interface DesignVariableCatalog {
  availability: "available" | "unavailable" | "not_requested";
  collections: DesignVariableCollectionSummary[];
  variables: DesignVariableSummary[];
  reason?: string;
}

export interface DesignDocumentSummary {
  rootId: string;
  name: string;
  version: DesignSourceVersion;
  editorType?: string;
  thumbnailUrl?: string;
  pages: DesignTreeNodeSummary[];
  components: DesignComponentSummary[];
  componentSets: DesignComponentSummary[];
  styles: DesignStyleSummary[];
  variables: DesignVariableCatalog;
  flows: DesignFlowSummary[];
  counts: {
    pages: number;
    topLevelNodes: number;
    components: number;
    componentSets: number;
    styles: number;
    variables: number;
    flows: number;
  };
  warnings: string[];
}

export interface DesignSourceNodePayload {
  id: string;
  document: Record<string, unknown>;
}

export type DesignIrNodeKind =
  | "page"
  | "container"
  | "component"
  | "component_set"
  | "instance"
  | "text"
  | "shape"
  | "vector"
  | "image"
  | "unknown";

export interface DesignIrPaint {
  type: "solid" | "gradient" | "image" | "unknown";
  visible: boolean;
  opacity: number;
  color?: { red: number; green: number; blue: number; alpha: number };
  imageRef?: string;
  variableId?: string;
}

export interface DesignIrLayout {
  mode: "none" | "row" | "column";
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  gap: number;
  padding: { top: number; right: number; bottom: number; left: number };
  primarySizing: "fixed" | "hug" | "fill" | "unknown";
  counterSizing: "fixed" | "hug" | "fill" | "unknown";
  primaryAlign: "start" | "center" | "end" | "space_between" | "unknown";
  counterAlign: "start" | "center" | "end" | "baseline" | "unknown";
  absolute: boolean;
  clipsContent: boolean;
}

export interface DesignIrTextStyle {
  characters: string;
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
  lineHeightPx?: number;
  letterSpacing?: number;
  textAlign: "start" | "center" | "end" | "justified" | "unknown";
}

export interface DesignIrNode {
  id: string;
  sourceId: string;
  sourcePath: string[];
  name: string;
  sourceType: DesignNodeType;
  kind: DesignIrNodeKind;
  visible: boolean;
  layout: DesignIrLayout;
  opacity: number;
  blendMode: string;
  cornerRadius?: number;
  fills: DesignIrPaint[];
  strokes: DesignIrPaint[];
  effects: string[];
  text?: DesignIrTextStyle;
  componentId?: string;
  variableIds: string[];
  imageRefs: string[];
  interactionTargetIds: string[];
  children: DesignIrNode[];
}

export interface NormalizedDesignIR {
  schemaVersion: 1;
  sourceImportId: string;
  sourceVersion: string;
  targetNodeIds: string[];
  roots: DesignIrNode[];
  nodeCount: number;
  hash: string;
}

export type DesignIssueSeverity = "blocking" | "confirmation" | "reminder";

export interface DesignPlanIssue {
  id: string;
  severity: DesignIssueSeverity;
  code: string;
  title: string;
  message: string;
  sourceNodeIds: string[];
  suggestedResolution?: string;
}

export interface HarmonyProjectComponent {
  name: string;
  relativePath: string;
}

export interface HarmonyProjectModule {
  name: string;
  relativePath: string;
  sourceRoot?: string;
  resourceRoot?: string;
  targets: string[];
  moduleType?: string;
  mainElement?: string;
  abilityName?: string;
  components: HarmonyProjectComponent[];
}

export interface HarmonyProjectInventory {
  schemaVersion: 1;
  projectRoot: string;
  modules: HarmonyProjectModule[];
  selectedModule?: string;
  selectedTarget?: string;
  products: string[];
  selectedProduct?: string;
  compileSdkVersion?: string;
  compatibleSdkVersion?: string;
  bundleName?: string;
  scannedFiles: number;
  truncated: boolean;
}

export interface DesignDependencyClosure {
  componentNodeIds: string[];
  variableIds: string[];
  assetRefs: string[];
  interactionNodeIds: string[];
}

export interface HarmonyComponentMapping {
  sourceNodeId: string;
  sourceName: string;
  strategy: "project_component" | "arkui_native" | "generate_component";
  targetName: string;
  targetPath?: string;
  confidence: "exact" | "inferred" | "fallback";
}

export interface HarmonyVariableMapping {
  variableId: string;
  sourceName: string;
  resolvedType: DesignVariableSummary["resolvedType"];
  resourceType: "color" | "float" | "string" | "boolean" | "unknown";
  resourceName: string;
  arkuiReference: string;
}

export interface HarmonyInteractionMapping {
  sourceNodeId: string;
  targetNodeId: string;
  strategy: "router_push" | "dialog" | "state_change" | "placeholder";
  handlerName: string;
}

export interface HarmonyFilePlan {
  sourceNodeId: string;
  sourceName: string;
  relativePath: string;
  symbolName: string;
  rootComponent: "Row" | "Column" | "Stack" | "Text" | "Image" | "Shape";
}

export interface HarmonyUiPlan {
  schemaVersion: 1;
  id: string;
  sourceImportId: string;
  sourceVersion: string;
  projectRoot: string;
  targetNodeIds: string[];
  targetModule?: string;
  dependencies: DesignDependencyClosure;
  files: HarmonyFilePlan[];
  componentMappings: HarmonyComponentMapping[];
  variableMappings: HarmonyVariableMapping[];
  interactionMappings: HarmonyInteractionMapping[];
  issues: DesignPlanIssue[];
  stats: {
    irNodes: number;
    outputFiles: number;
    blockingIssues: number;
    confirmationIssues: number;
    reminders: number;
  };
  irHash: string;
  hash: string;
}

export interface ArkUiAstModifier {
  name: string;
  arguments: string[];
}

export interface ArkUiAstNode {
  sourceNodeId: string;
  component: string;
  constructorArguments: string[];
  modifiers: ArkUiAstModifier[];
  children: ArkUiAstNode[];
  comment?: string;
}

export interface ArkUiAstMethod {
  name: string;
  body: string[];
}

export interface ArkUiAstImport {
  symbols: string[];
  path: string;
}

export interface ArkUiAstFile {
  sourceNodeId: string;
  sourceNodeIds: string[];
  relativePath: string;
  symbolName: string;
  imports: ArkUiAstImport[];
  methods: ArkUiAstMethod[];
  root: ArkUiAstNode;
  sourceVersion: string;
  planId: string;
}

export interface DesignAssetPlanItem {
  sourceNodeId: string;
  sourceRef: string;
  resourceName: string;
  relativePath: string;
  strategy: "source_render_png" | "placeholder_svg";
  fallbackReason?: string;
}

export type GeneratedArtifactKind = "arkts" | "media" | "metadata";

export interface GeneratedArtifactRecord {
  relativePath: string;
  kind: GeneratedArtifactKind;
  mediaType: string;
  bytes: number;
  sha256: string;
  sourceNodeIds: string[];
  symbolName?: string;
  managed: true;
}

export interface GeneratedArtifactManifest {
  schemaVersion: 1;
  id: string;
  runId: string;
  planId: string;
  sourceVersion: string;
  generatorVersion: string;
  irHash: string;
  planHash: string;
  artifacts: GeneratedArtifactRecord[];
  assetPlan: DesignAssetPlanItem[];
  fallbackIssueIds: string[];
  totalBytes: number;
  hash: string;
}

export interface DesignPreviewPointer {
  id: string;
  manifestHash: string;
  generatorVersion: string;
  artifactCount: number;
  totalBytes: number;
  generatedAt: string;
}

export interface DesignPreviewFile {
  artifact: GeneratedArtifactRecord;
  encoding: "utf8" | "base64";
  content: string;
  absolutePath: string;
}

export type DesignManagedFileMode = "managed" | "detached";

export interface DesignManagedFileRecord {
  relativePath: string;
  mode: DesignManagedFileMode;
  sourceImportId: string;
  sourceVersion: string;
  planId: string;
  previewId: string;
  generatorVersion: string;
  sourceNodeIds: string[];
  appliedSha256: string;
  appliedAt: string;
  detachedAt?: string;
}

export interface DesignManagedProjectState {
  schemaVersion: 1;
  projectRoot: string;
  revision: number;
  files: DesignManagedFileRecord[];
}

export type DesignPatchConflictCode =
  | "unmanaged_existing"
  | "managed_modified"
  | "detached_file"
  | "non_regular_target"
  | "non_text_target"
  | "target_too_large";

export type DesignPatchChange = "add" | "modify" | "unchanged" | "conflict";

export interface DesignPatchFile {
  relativePath: string;
  targetPath: string;
  kind: GeneratedArtifactKind;
  mediaType: string;
  change: DesignPatchChange;
  conflictCode?: DesignPatchConflictCode;
  conflictMessage?: string;
  overwriteAllowed: boolean;
  managementMode: DesignManagedFileMode | "unmanaged";
  currentExists: boolean;
  currentSha256?: string;
  currentBytes?: number;
  previewSha256: string;
  previewBytes: number;
  additions: number;
  deletions: number;
  patch: string;
  binary: boolean;
  sourceNodeIds: string[];
}

export interface DesignPatchSet {
  schemaVersion: 1;
  id: string;
  runId: string;
  previewId: string;
  planId: string;
  projectRoot: string;
  runRevision: number;
  managedStateRevision: number;
  files: DesignPatchFile[];
  stats: {
    additions: number;
    modifications: number;
    unchanged: number;
    conflicts: number;
    linesAdded: number;
    linesDeleted: number;
  };
  canApply: boolean;
  hash: string;
}

export interface DesignApplyRecord {
  id: string;
  patchId: string;
  appliedAt: string;
  appliedPaths: string[];
  overwrittenPaths: string[];
}

export interface DesignAnalysisRun {
  schemaVersion: 1;
  id: string;
  projectRoot: string;
  importId: string;
  sourceVersion: string;
  targetNodeIds: string[];
  scopeMode?: "selection" | "flow";
  status: "planned" | "generating" | "generated" | "ready_to_apply" | "applying" | "applied" | "validating" | "cancelling" | "cancelled" | "failed" | "interrupted";
  revision: number;
  createdAt: string;
  updatedAt: string;
  plan?: HarmonyUiPlan;
  preview?: DesignPreviewPointer;
  lastApply?: DesignApplyRecord;
  validation?: DesignValidationResult;
  syncImpact?: DesignSyncImpact;
  error?: { code: string; message: string; retryable: boolean };
}

export type DesignDiagnosticSeverity = "error" | "warning" | "info";

export interface DesignBuildDiagnostic {
  severity: DesignDiagnosticSeverity;
  code?: string;
  message: string;
  relativePath?: string;
  line?: number;
  column?: number;
  sourceNodeIds: string[];
}

export interface HarmonyBuildProfile {
  projectRoot: string;
  module: string;
  target: string;
  product: string;
  buildMode: "debug" | "release";
  compileSdkVersion?: string;
  compatibleSdkVersion?: string;
  sdkPath: string;
  nodePath: string;
  wrapperPath: string;
}

export interface DesignBuildResult {
  status: "passed" | "failed" | "cancelled" | "unavailable";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode?: number;
  timedOut: boolean;
  outputTruncated: boolean;
  logTail: string;
  hapPath?: string;
  profile?: HarmonyBuildProfile;
  diagnostics: DesignBuildDiagnostic[];
}

export interface DesignVisualDiffRegion {
  left: number;
  top: number;
  right: number;
  bottom: number;
  changedPixels: number;
  ratio: number;
  uiNodeRefs: string[];
  sourceNodeIds: string[];
}

export interface DesignVisualComparison {
  status: "passed" | "different" | "unavailable" | "cancelled";
  referencePath?: string;
  actualPath?: string;
  diffPath?: string;
  width?: number;
  height?: number;
  changedPixels?: number;
  changedRatio?: number;
  threshold: number;
  regions: DesignVisualDiffRegion[];
  message?: string;
}

export interface DesignDeviceValidation {
  status: "passed" | "failed" | "unavailable" | "cancelled";
  serial?: string;
  bundleName?: string;
  abilityName?: string;
  installed: boolean;
  launched: boolean;
  stable: boolean;
  message?: string;
}

export interface DesignValidationResult {
  id: string;
  mode: "preview" | "applied";
  startedAt: string;
  completedAt: string;
  build: DesignBuildResult;
  device?: DesignDeviceValidation;
  visual?: DesignVisualComparison;
}

export interface DesignSyncImpact {
  previousImportId?: string;
  changedNodeIds: string[];
  unchangedNodeIds: string[];
  removedNodeIds: string[];
  affectedSourceNodeIds: string[];
  affectedRelativePaths: string[];
  reason: "first_import" | "source_version_changed" | "unchanged";
}

export interface DesignAnalysisResponse {
  run: DesignAnalysisRun;
  cached: boolean;
}

export interface DesignGenerationResponse {
  run: DesignAnalysisRun;
  preview: GeneratedArtifactManifest;
  cached: boolean;
}

export interface DesignPreviewResponse {
  run: DesignAnalysisRun;
  preview: GeneratedArtifactManifest;
  file?: DesignPreviewFile;
}

export interface DesignReviewResponse {
  run: DesignAnalysisRun;
  patch: DesignPatchSet;
}

export interface DesignApplyTokenResponse {
  run: DesignAnalysisRun;
  patch: DesignPatchSet;
  applyToken: string;
  expiresAt: string;
}

export interface DesignApplyResponse {
  run: DesignAnalysisRun;
  patch: DesignPatchSet;
  applied: DesignApplyRecord;
}

export interface DesignAssetRequest {
  nodeId: string;
  format: "png" | "jpg" | "svg" | "pdf";
  scale?: number;
}

export interface DesignAssetResult {
  nodeId: string;
  url: string | null;
}

export interface DesignReferenceRender {
  nodeId: string;
  url: string | null;
}

export interface DesignImageFillResult {
  imageRef: string;
  url: string | null;
}

export interface DesignImportRecord {
  schemaVersion: 1;
  id: string;
  projectRoot: string;
  source: DesignSourceRef;
  document: DesignDocumentSummary;
  importedAt: string;
  updatedAt: string;
}

export interface DesignCredentialStatus {
  provider: DesignSourceProvider;
  configured: boolean;
  updatedAt?: string;
}

export interface DesignImportListResponse {
  imports: DesignImportRecord[];
}

export interface DesignImportResponse {
  record: DesignImportRecord;
  cached: boolean;
}
