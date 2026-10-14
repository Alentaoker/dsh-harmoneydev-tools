import { posix } from "node:path";
import { flattenDesignIr } from "./normalize";
import type {
  ArkUiAstFile,
  ArkUiAstImport,
  ArkUiAstMethod,
  ArkUiAstModifier,
  ArkUiAstNode,
  DesignAssetPlanItem,
  DesignIrNode,
  HarmonyComponentMapping,
  HarmonyUiPlan,
  NormalizedDesignIR,
} from "./types";

function numberExpression(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function colorExpression(node: DesignIrNode): string | undefined {
  const paint = node.fills.find((item) => item.visible && item.type === "solid" && item.color);
  if (!paint?.color) return undefined;
  const channel = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, "0").toUpperCase();
  const rgb = `${channel(paint.color.red)}${channel(paint.color.green)}${channel(paint.color.blue)}`;
  const alpha = paint.color.alpha * paint.opacity * node.opacity;
  return JSON.stringify(alpha < 0.999 ? `#${channel(alpha)}${rgb}` : `#${rgb}`);
}

function paddingExpression(node: DesignIrNode): string | undefined {
  const { top, right, bottom, left } = node.layout.padding;
  if ([top, right, bottom, left].every((value) => value === 0)) return undefined;
  if (top === right && right === bottom && bottom === left) return numberExpression(top);
  return `{ top: ${numberExpression(top)}, right: ${numberExpression(right)}, bottom: ${numberExpression(bottom)}, left: ${numberExpression(left)} }`;
}

function mainAlignment(node: DesignIrNode): string | undefined {
  if (node.layout.primaryAlign === "center") return "FlexAlign.Center";
  if (node.layout.primaryAlign === "end") return "FlexAlign.End";
  if (node.layout.primaryAlign === "space_between") return "FlexAlign.SpaceBetween";
  return undefined;
}

function crossAlignment(node: DesignIrNode, component: string): string | undefined {
  if (node.layout.counterAlign === "unknown" || node.layout.counterAlign === "baseline") return undefined;
  if (component === "Column") {
    if (node.layout.counterAlign === "start") return "HorizontalAlign.Start";
    if (node.layout.counterAlign === "center") return "HorizontalAlign.Center";
    if (node.layout.counterAlign === "end") return "HorizontalAlign.End";
  }
  if (component === "Row") {
    if (node.layout.counterAlign === "start") return "VerticalAlign.Top";
    if (node.layout.counterAlign === "center") return "VerticalAlign.Center";
    if (node.layout.counterAlign === "end") return "VerticalAlign.Bottom";
  }
  return undefined;
}

function builtInComponent(node: DesignIrNode): string {
  if (node.kind === "text") return "Text";
  if (node.kind === "image") return "Image";
  if (node.layout.mode === "row") return "Row";
  if (node.layout.mode === "column") return "Column";
  return "Stack";
}

function constructorArguments(node: DesignIrNode, component: string, assets: Map<string, DesignAssetPlanItem>): string[] {
  if (component === "Text") return [JSON.stringify(node.text?.characters ?? node.name)];
  if (component === "Image") {
    const asset = assets.get(node.id);
    return [asset ? `$r('app.media.${asset.resourceName}')` : JSON.stringify("")];
  }
  if ((component === "Row" || component === "Column") && node.layout.gap !== 0) {
    return [`{ space: ${numberExpression(node.layout.gap)} }`];
  }
  return [];
}

function modifiers(node: DesignIrNode, component: string, parent?: DesignIrNode): ArkUiAstModifier[] {
  const output: ArkUiAstModifier[] = [];
  if (node.layout.width !== undefined) output.push({ name: "width", arguments: [numberExpression(node.layout.width)] });
  if (node.layout.height !== undefined) output.push({ name: "height", arguments: [numberExpression(node.layout.height)] });
  if (node.layout.absolute && node.layout.x !== undefined && node.layout.y !== undefined) {
    const x = node.layout.x - (parent?.layout.x ?? 0);
    const y = node.layout.y - (parent?.layout.y ?? 0);
    output.push({ name: "position", arguments: [`{ x: ${numberExpression(x)}, y: ${numberExpression(y)} }`] });
  }
  const color = colorExpression(node);
  if (component === "Text") {
    if (color) output.push({ name: "fontColor", arguments: [color] });
    if (node.text?.fontSize !== undefined) output.push({ name: "fontSize", arguments: [numberExpression(node.text.fontSize)] });
    if (node.text?.fontWeight !== undefined) output.push({ name: "fontWeight", arguments: [numberExpression(node.text.fontWeight)] });
    if (node.text?.lineHeightPx !== undefined) output.push({ name: "lineHeight", arguments: [numberExpression(node.text.lineHeightPx)] });
    if (node.text?.letterSpacing !== undefined) output.push({ name: "letterSpacing", arguments: [numberExpression(node.text.letterSpacing)] });
    if (node.text?.textAlign === "center") output.push({ name: "textAlign", arguments: ["TextAlign.Center"] });
    if (node.text?.textAlign === "end") output.push({ name: "textAlign", arguments: ["TextAlign.End"] });
  } else if (color) {
    output.push({ name: "backgroundColor", arguments: [color] });
  }
  if (node.opacity < 0.999) output.push({ name: "opacity", arguments: [numberExpression(node.opacity)] });
  if (node.cornerRadius !== undefined && node.cornerRadius > 0) output.push({ name: "borderRadius", arguments: [numberExpression(node.cornerRadius)] });
  const padding = paddingExpression(node);
  if (padding && component !== "Text" && component !== "Image") output.push({ name: "padding", arguments: [padding] });
  const justify = mainAlignment(node);
  if (justify && (component === "Row" || component === "Column")) output.push({ name: "justifyContent", arguments: [justify] });
  const align = crossAlignment(node, component);
  if (align) output.push({ name: "alignItems", arguments: [align] });
  return output;
}

function importPath(from: string, to: string): string {
  const relative = posix.relative(posix.dirname(from), to.replace(/\.ets$/i, ""));
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function buildFileAst(input: {
  file: HarmonyUiPlan["files"][number];
  root: DesignIrNode;
  plan: HarmonyUiPlan;
  mappingByNode: Map<string, HarmonyComponentMapping>;
  assetByNode: Map<string, DesignAssetPlanItem>;
}): ArkUiAstFile {
  const imports = new Map<string, Set<string>>();
  const methods = new Map<string, ArkUiAstMethod>();
  const interactionByNode = new Map<string, HarmonyUiPlan["interactionMappings"]>();
  for (const mapping of input.plan.interactionMappings) {
    interactionByNode.set(mapping.sourceNodeId, [...(interactionByNode.get(mapping.sourceNodeId) ?? []), mapping]);
  }
  const visit = (node: DesignIrNode, parent?: DesignIrNode): ArkUiAstNode => {
    const componentMapping = input.mappingByNode.get(node.id);
    const reuseProjectComponent = node.id !== input.root.id
      && componentMapping?.strategy === "project_component"
      && componentMapping.targetPath;
    const component = reuseProjectComponent ? componentMapping.targetName : builtInComponent(node);
    if (reuseProjectComponent && componentMapping.targetPath) {
      const path = importPath(input.file.relativePath, componentMapping.targetPath);
      const symbols = imports.get(path) ?? new Set<string>();
      symbols.add(componentMapping.targetName);
      imports.set(path, symbols);
    }
    const nodeModifiers = modifiers(node, component, parent);
    for (const interaction of interactionByNode.get(node.id) ?? []) {
      methods.set(interaction.handlerName, {
        name: interaction.handlerName,
        body: [`console.info(${JSON.stringify(`Piora design interaction ${interaction.sourceNodeId} -> ${interaction.targetNodeId}`)})`],
      });
      nodeModifiers.push({ name: "onClick", arguments: [`() => { this.${interaction.handlerName}() }`] });
    }
    return {
      sourceNodeId: node.id,
      component,
      constructorArguments: constructorArguments(node, component, input.assetByNode),
      modifiers: nodeModifiers,
      children: reuseProjectComponent ? [] : node.children.filter((child) => child.visible).map((child) => visit(child, node)),
      comment: reuseProjectComponent ? `Reuses project component ${componentMapping.targetName}` : undefined,
    };
  };
  const root = visit(input.root);
  return {
    sourceNodeId: input.root.id,
    sourceNodeIds: flattenDesignIr([input.root]).map((node) => node.id).sort(),
    relativePath: input.file.relativePath,
    symbolName: input.file.symbolName,
    imports: [...imports.entries()].map(([path, symbols]): ArkUiAstImport => ({ path, symbols: [...symbols].sort() }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    methods: [...methods.values()].sort((left, right) => left.name.localeCompare(right.name)),
    root,
    sourceVersion: input.plan.sourceVersion,
    planId: input.plan.id,
  };
}

export function buildArkUiAst(ir: NormalizedDesignIR, plan: HarmonyUiPlan, assetPlan: DesignAssetPlanItem[]): ArkUiAstFile[] {
  const roots = new Map(ir.roots.map((root) => [root.id, root]));
  const allNodes = new Map(flattenDesignIr(ir.roots).map((node) => [node.id, node]));
  const mappingByNode = new Map(plan.componentMappings.map((mapping) => [mapping.sourceNodeId, mapping]));
  const assetByNode = new Map(assetPlan.map((asset) => [asset.sourceNodeId, asset]));
  return plan.files.flatMap((file) => {
    const root = roots.get(file.sourceNodeId) ?? allNodes.get(file.sourceNodeId);
    return root ? [buildFileAst({ file, root, plan, mappingByNode, assetByNode })] : [];
  }).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
