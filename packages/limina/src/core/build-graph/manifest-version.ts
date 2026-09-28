export const generatedGraphManifestVersion = 5 as const;

export function isOwnedArtifactLedgerVersion(value: unknown): value is number {
  if (typeof value !== 'number') return false;
  return [
    Number.isInteger(value),
    value > 0,
    value <= generatedGraphManifestVersion,
  ].every(Boolean);
}
