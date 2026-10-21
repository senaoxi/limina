import type { NativeEvidenceSnapshot } from './native-evidence';
import { freezeNativeData } from './native-evidence-freeze';
import { summarizeCompilationObligation } from './native-obligation';

/**
 * Completion describes observation work, never governance compliance or
 * permission to execute a build. Unknown relations are retained, not failures.
 */
export interface NativeCollectionStatus {
  readonly execution: 'completed' | 'partial' | 'failed';
  readonly traversal: 'complete-within-boundary' | 'incomplete';
  readonly compilationRelations: 'determined' | 'undetermined';
  readonly failureIds: readonly string[];
  readonly undeterminedObligationIds: readonly string[];
  readonly relationBoundaryIds: readonly string[];
}

export function nativeCollectionStatus(
  snapshot: NativeEvidenceSnapshot,
): NativeCollectionStatus {
  const unknown = snapshot.obligations.filter(
    (obligation) => summarizeCompilationObligation(obligation) === 'unknown',
  );
  const boundaries = relationBoundaries(snapshot);
  return freezeNativeData({
    execution: executionStatus(snapshot),
    traversal: hasTraversalGap(snapshot)
      ? 'incomplete'
      : 'complete-within-boundary',
    compilationRelations: relationStatus(
      snapshot,
      unknown.length + boundaries.length,
    ),
    failureIds: snapshot.failures.map((failure) => failure.id),
    undeterminedObligationIds: unknown.map((obligation) => obligation.id),
    relationBoundaryIds: boundaries,
  });
}

function relationBoundaries(snapshot: NativeEvidenceSnapshot): string[] {
  return snapshot.completeness
    .filter(
      (partition) =>
        partition.state === 'proven-stop' &&
        [
          'uncovered',
          'coverage-unavailable',
          'observation-unavailable',
          'ambiguous-implementation',
        ].includes(partition.stopReason),
    )
    .map((partition) => partition.entryId);
}

function relationStatus(
  snapshot: NativeEvidenceSnapshot,
  unknownCount: number,
): NativeCollectionStatus['compilationRelations'] {
  return unknownCount === 0 && !hasTraversalGap(snapshot)
    ? 'determined'
    : 'undetermined';
}

function hasTraversalGap(snapshot: NativeEvidenceSnapshot): boolean {
  return (
    snapshot.run !== 'completed' ||
    snapshot.completeness.some((partition) => partition.state === 'gap')
  );
}

function executionStatus(
  snapshot: NativeEvidenceSnapshot,
): NativeCollectionStatus['execution'] {
  if (isCompleted(snapshot)) return 'completed';
  return snapshot.completeness.some((partition) => partition.state !== 'gap')
    ? 'partial'
    : 'failed';
}

function isCompleted(snapshot: NativeEvidenceSnapshot): boolean {
  return snapshot.run === 'completed' && snapshot.failures.length === 0;
}
