import { isDeclarationFile } from '../core/import-graph/declaration-classifier';
import { shouldInferDeclarationReferenceFromImportRecord } from '../core/import-graph/declaration-reference-evidence';
import { getWorkspaceConsumptionFailure } from '../core/project-dependencies/workspace-consumption';
import type { NativeDependencyFact } from '../core/typescript-semantic/dependency-fact';
import { qualifyNativeEvidence } from '../domain/analysis/native-context';
import { isAddBuildArtifactImportProblem } from './artifact-import-findings';
import { addUnmappedWorkspaceImportProblem } from './outside-graph-findings';
import { resolveImportForGraphGovernance } from './reference-import-resolution';
import type { GraphImportResolution } from './reference-types';

type NativePolicyInput = Parameters<typeof resolveImportForGraphGovernance>[0];

function isQualifiedUncovered(
  evidence: NativeDependencyFact['nativeEvidence'],
): boolean {
  if (evidence === undefined) return false;
  return [
    evidence.coverage?.state === 'uncovered',
    qualifyNativeEvidence(
      evidence.origin,
      evidence.origin.context,
      'locked-fact',
    ).eligible,
  ].every(Boolean);
}

function shouldGovernCoverage(options: NativePolicyInput): boolean {
  return [
    isQualifiedUncovered(options.projectDependency.nativeFact?.nativeEvidence),
    shouldInferDeclarationReferenceFromImportRecord(options.importRecord),
    // Missing/untyped package entry findings belong to runtime governance.
    getWorkspaceConsumptionFailure({
      consumption: options.projectDependency,
      workspaceLookup: options.context.workspaceLookup,
    }) === null,
  ].every(Boolean);
}

function isImplementationResolution(
  resolution: GraphImportResolution | null,
): resolution is GraphImportResolution {
  return (
    resolution !== null && !isDeclarationFile(resolution.graphResolvedFilePath)
  );
}

function resolveGovernedImport(
  options: NativePolicyInput,
): GraphImportResolution | null {
  if (!shouldGovernCoverage(options)) return null;
  const resolution = resolveImportForGraphGovernance(options);
  return isImplementationResolution(resolution) ? resolution : null;
}

/**
 * An expected Core stop can still be input to an independent workspace policy.
 * Only proven non-membership qualifies; unavailable coverage is not a violation.
 * This consumer records findings and never infers or changes compilation edges.
 */
export function recordNativeCoverageGovernance(
  options: NativePolicyInput,
): void {
  const resolution = resolveGovernedImport(options);
  if (resolution === null) return;
  const policyInput = { ...options, resolution };
  if (!isAddBuildArtifactImportProblem(policyInput))
    addUnmappedWorkspaceImportProblem(policyInput);
}
