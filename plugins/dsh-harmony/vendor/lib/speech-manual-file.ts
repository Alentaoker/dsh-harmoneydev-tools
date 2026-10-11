/**
 * Browsers append " (1)", " (2)", ... when the same file is downloaded
 * repeatedly. Accept that harmless rename while keeping the server-side
 * checksum as the authority for file identity.
 */
export function matchManualSpeechSourceName(
  fileName: string,
  expectedNames: readonly string[],
): string | null {
  const normalized = fileName.normalize("NFKC").trim();
  const withoutDownloadSuffix = normalized.replace(/ \(\d+\)(?=\.[^.]+$)/u, "");
  return expectedNames.find((expected) => (
    expected.localeCompare(normalized, undefined, { sensitivity: "accent" }) === 0
    || expected.localeCompare(withoutDownloadSuffix, undefined, { sensitivity: "accent" }) === 0
  )) ?? null;
}
