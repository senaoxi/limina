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
  markRelationCompleteness(analysis, collected);
}

export function mergeNativeAnalysis(
  target: DependencyAnalysisResult,
  source: DependencyAnalysisResult,
): void {
  (target.declarationContexts ??= []).push(
    ...(source.declarationContexts ?? []),
  );
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

function markRelationCompleteness(
  analysis: DependencyAnalysisResult,
  collected: NativeCollectionStatus,
): void {
  analysis.complete &&= collected.compilationRelations === 'determined';
}
