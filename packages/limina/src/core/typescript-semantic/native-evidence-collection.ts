import type { NativeEvidenceSnapshot } from '../../domain/analysis/native-evidence';
import { NATIVE_EVIDENCE_VERSION } from '../../domain/analysis/native-evidence';
import { freezeNativeData } from '../../domain/analysis/native-evidence-freeze';
import { failedNativeSnapshot } from './native-context-failure';
import {
  NativeObservationAdapter,
  type NativeProgramObservationOptions,
} from './native-observation-adapter';

/**
 * Independent contexts continue after a failed context. Failed transactions
 * never masquerade as a successful empty graph; useful partitions survive.
 */
export function collectNativeEvidence(
  inputs: readonly NativeProgramObservationOptions[],
): NativeEvidenceSnapshot {
  const snapshots = inputs.map(collectContext);
  return freezeNativeData({
    version: NATIVE_EVIDENCE_VERSION,
    run: snapshots.every((snapshot) => snapshot.run === 'completed')
      ? 'completed'
      : 'unavailable',
    contexts: snapshots.flatMap((snapshot) => snapshot.contexts),
    coverageIndexes: [...new Set(inputs.map((input) => input.coverage))],
    coverage: snapshots.flatMap((snapshot) => snapshot.coverage),
    requests: snapshots.flatMap((snapshot) => snapshot.requests),
    traversal: snapshots.flatMap((snapshot) => snapshot.traversal),
    resolutions: snapshots.flatMap((snapshot) => snapshot.resolutions),
    relations: snapshots.flatMap((snapshot) => snapshot.relations),
    obligations: snapshots.flatMap((snapshot) => snapshot.obligations),
    completeness: snapshots.flatMap((snapshot) => snapshot.completeness),
    failures: snapshots.flatMap((snapshot) => snapshot.failures),
  });
}

function collectContext(
  input: NativeProgramObservationOptions,
): NativeEvidenceSnapshot {
  try {
    return new NativeObservationAdapter(input).snapshot;
  } catch (error) {
    return failedNativeSnapshot(input, error);
  }
}
