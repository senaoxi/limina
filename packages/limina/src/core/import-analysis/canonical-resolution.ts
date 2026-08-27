import type { CanonicalImportResolutionEvidence } from './types';

function getTypeScriptResolvedFilePath(
  evidence: CanonicalImportResolutionEvidence,
): string | null {
  const resolution = evidence.typeScriptResolution;
  if (resolution === null) return null;
  return resolution.resolvedFileName;
}

function selectResourceFilePath(options: {
  evidence: CanonicalImportResolutionEvidence;
  includeResource: boolean;
}): string | null {
  if (!options.includeResource) return null;
  const runtime = options.evidence.runtimeEvidence.runtime;
  if (runtime.kind !== 'file') return null;
  return runtime.filePath;
}

function hasAstroSemanticEvidence(
  evidence: CanonicalImportResolutionEvidence,
): boolean {
  return evidence.semanticEvidence?.framework === 'astro';
}

function selectFallbackSourceFilePath(options: {
  oxcResolvedFilePath: string | null;
  typeScriptResolvedFilePath: string | null;
}): string | null {
  if (options.typeScriptResolvedFilePath !== null) {
    return options.typeScriptResolvedFilePath;
  }
  return options.oxcResolvedFilePath;
}

function selectSourceFilePath(
  evidence: CanonicalImportResolutionEvidence,
): string | null {
  const typeScript = getTypeScriptResolvedFilePath(evidence);
  if (hasAstroSemanticEvidence(evidence)) return typeScript;
  return selectFallbackSourceFilePath({
    oxcResolvedFilePath: evidence.oxcResolvedFilePath,
    typeScriptResolvedFilePath: typeScript,
  });
}

export function selectCanonicalImportFilePath(options: {
  evidence: CanonicalImportResolutionEvidence;
  includeResource: boolean;
}): string | null {
  if (options.evidence.semanticFailure !== undefined) return null;
  if (options.evidence.runtimeEvidence.classification === 'resource') {
    return selectResourceFilePath(options);
  }
  return selectSourceFilePath(options.evidence);
}
