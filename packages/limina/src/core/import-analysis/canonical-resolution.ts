import type { CanonicalImportResolutionEvidence } from './types';

function getTypeScriptResolvedFilePath(
  evidence: CanonicalImportResolutionEvidence,
): string | null {
  const resolution = evidence.typeScriptResolution;
  return resolution === null ? null : resolution.resolvedFileName;
}

function selectResourceFilePath(options: {
  evidence: CanonicalImportResolutionEvidence;
  includeResource: boolean;
}): string | null {
  if (!options.includeResource) return null;
  const runtime = options.evidence.runtimeEvidence.runtime;
  return runtime.kind === 'file' ? runtime.filePath : null;
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
  return options.typeScriptResolvedFilePath === null
    ? options.oxcResolvedFilePath
    : options.typeScriptResolvedFilePath;
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
  return options.evidence.runtimeEvidence.classification === 'resource'
    ? selectResourceFilePath(options)
    : selectSourceFilePath(options.evidence);
}
