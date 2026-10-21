import { nativeCollectionStatus } from './native-collection';
import type { NativeEvidenceSnapshot } from './native-evidence';
import { freezeNativeData } from './native-evidence-freeze';
import {
  type CompilationObligationSummary,
  type NativeCompilationObligation,
  summarizeCompilationObligation,
} from './native-obligation';

export interface NativeProjectedRelation {
  readonly obligation: NativeCompilationObligation;
  readonly summary: CompilationObligationSummary;
}

/**
 * A lossless view of compilation obligations. Governance and provider selection
 * may attach independent decisions; neither can remove an unknown obligation
 * or turn this view into a complete graph by filtering its contents.
 */
export interface NativeReferenceProjection {
  readonly observedRelations: NativeEvidenceSnapshot['relations'];
  readonly relations: readonly NativeProjectedRelation[];
  readonly completeness: 'determined' | 'undetermined';
  readonly unresolvedObligationIds: readonly string[];
  readonly collectionFailureIds: readonly string[];
  readonly relationBoundaryIds: readonly string[];
}

export function projectNativeReferences(
  snapshot: NativeEvidenceSnapshot,
): NativeReferenceProjection {
  const relations = snapshot.obligations.map((obligation) => ({
    obligation,
    summary: summarizeCompilationObligation(obligation),
  }));
  const unresolved = relations.filter(
    (relation) => relation.summary === 'unknown',
  );
  const failureIds = snapshot.failures.map((failure) => failure.id);
  const collection = nativeCollectionStatus(snapshot);
  return freezeNativeData({
    observedRelations: snapshot.relations,
    relations,
    completeness: collection.compilationRelations,
    relationBoundaryIds: collection.relationBoundaryIds,
    unresolvedObligationIds: unresolved.map(
      (relation) => relation.obligation.id,
    ),
    collectionFailureIds: failureIds,
  });
}
