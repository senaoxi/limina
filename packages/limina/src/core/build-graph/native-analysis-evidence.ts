import {
  nativeCollectionStatus,
  type NativeCollectionStatus,
} from '../../domain/analysis/native-collection';
import type { NativeEvidenceSnapshot } from '../../domain/analysis/native-evidence';
import {
  type NativeReferenceProjection,
  projectNativeReferences,
} from '../../domain/analysis/native-reference-projection';
import type { DependencyAnalysisResult } from './types';

export interface NativeAnalysisEvidence {
  readonly snapshot: NativeEvidenceSnapshot;
  readonly collection: NativeCollectionStatus;
  readonly referenceProjection: NativeReferenceProjection;
}

/**
Keep original records independently of filtering/decisions in legacy views.
*/
export function retainNativeAnalysis(
  analysis: DependencyAnalysisResult | undefined,
  snapshot: NativeEvidenceSnapshot | undefined,
): void {
  if (analysis === undefined || snapshot === undefined) return;
  appendNativeAnalysis(analysis, snapshot);
}

function appendNativeAnalysis(
  analysis: DependencyAnalysisResult,
  snapshot: NativeEvidenceSnapshot,
): void {
  const collected = nativeCollectionStatus(snapshot);
  analysis.nativeEvidence ??= [];
  if (analysis.nativeEvidence.some((entry) => entry.snapshot === snapshot))
    return;
  analysis.nativeEvidence.push({
    snapshot,
    collection: collected,
    referenceProjection: projectNativeReferences(snapshot),
  });
  analysis.complete &&=
    effectiveNativeCollection(analysis, snapshot, collected)
      .compilationRelations === 'determined';
}

export function mergeNativeAnalysis(
  target: DependencyAnalysisResult,
  source: DependencyAnalysisResult,
): void {
  if (source.unresolvedDependencies?.length)
    (target.unresolvedDependencies ??= []).push(
      ...source.unresolvedDependencies,
    );
  (target.declarationEvidence ??= []).push(
    ...(source.declarationEvidence ?? []),
  );
  if (source.inactiveDeclarationRequests?.length)
    (target.inactiveDeclarationRequests ??= []).push(
      ...source.inactiveDeclarationRequests,
    );
  (target.declarationContexts ??= []).push(
    ...(source.declarationContexts ?? []),
  );
  if (source.packageRequests?.length)
    (target.packageRequests ??= []).push(...source.packageRequests);
  target.facts.push(...source.facts);
  target.diagnostics.push(...source.diagnostics);
  target.complete &&= source.complete;
  appendNativeAssessments(target, source);
}

function appendNativeAssessments(
  target: DependencyAnalysisResult,
  source: DependencyAnalysisResult,
) {
  if (source.nativeEvidence === undefined) return;
  target.nativeEvidence ??= [];
  target.nativeEvidence.push(...source.nativeEvidence);
}

/** Raw observation completeness remains available on each snapshot. A proved
 * stop or unknown obligation from a delegated request concerns its observing
 * Program only. Failures and unbound gaps retain their original meaning. */
export function effectiveNativeCollection(
  analysis: DependencyAnalysisResult,
  snapshot: NativeEvidenceSnapshot,
  collected: NativeCollectionStatus,
): NativeCollectionStatus {
  if (
    collected.compilationRelations === 'determined' ||
    collected.traversal !== 'complete-within-boundary' ||
    !analysis.inactiveDeclarationRequests?.length
  )
    return collected;
  const inactive = new Set(analysis.inactiveDeclarationRequests);
  const unknown = new Set(collected.undeterminedObligationIds);
  for (const obligation of snapshot.obligations)
    if (
      obligation.requestIds.length > 0 &&
      obligation.requestIds.every((id) => inactive.has(id))
    )
      unknown.delete(obligation.id);
  const boundaries = collected.relationBoundaryIds.filter(
    (id) => !inactive.has(id),
  );
  return {
    ...collected,
    compilationRelations:
      unknown.size === 0 && boundaries.length === 0
        ? 'determined'
        : 'undetermined',
    undeterminedObligationIds: [...unknown],
    relationBoundaryIds: boundaries,
  };
}
