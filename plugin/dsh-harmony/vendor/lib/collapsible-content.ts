import { TEAM_DEFAULTS } from "./team-types";

export function shouldCollapseUserContent(metadata: { truncated: boolean; lineCount: number; byteLength: number }): boolean {
  return metadata.truncated
    || metadata.lineCount > TEAM_DEFAULTS.collapseAfterLines
    || metadata.byteLength > TEAM_DEFAULTS.collapseAfterChars;
}

export function previewUserContent(content: string): string {
  return content.split(/\r?\n/u).slice(0, TEAM_DEFAULTS.previewLines).join("\n");
}
