import type {
  NativeEvidenceFailure,
  NativeEvidenceSnapshot,
} from '../../domain/analysis/native-evidence';
import { NATIVE_EVIDENCE_VERSION } from '../../domain/analysis/native-evidence';
import { freezeNativeData } from '../../domain/analysis/native-evidence-freeze';
import type { TypeScriptSemanticDependencyContext } from './contracts';
import type { NativeProgramObservationOptions } from './native-observation-adapter';
import {
  nativeFailure,
  nativeObservationFailureKind,
  observationErrorDetail,
} from './native-observation-failure';
import { failurePartitions } from './native-program-partitions';

export function failedNativeSnapshot(
  input: NativeProgramObservationOptions,
  error: unknown,
): NativeEvidenceSnapshot {
  const failure = nativeFailure({
    contextId: input.context.id,
    kind: nativeObservationFailureKind(error),
    detail: observationErrorDetail(error),
  });
  return freezeNativeData(failedSnapshot(input, failure));
}

function failedSnapshot(
  input: NativeProgramObservationOptions,
  failure: NativeEvidenceFailure,
): NativeEvidenceSnapshot {
  return {
    version: NATIVE_EVIDENCE_VERSION,
    run: 'failed',
    contexts: [input.context],
    coverageIndexes: [input.coverage],
    coverage: [],
    requests: [],
    traversal: [],
    resolutions: [],
    relations: [],
    obligations: [],
    completeness: failurePartitions(input.context.id, failure),
    failures: [failure],
  };
}

export function failedNativeDependencyContext(
  input: NativeProgramObservationOptions,
  error: unknown,
): TypeScriptSemanticDependencyContext & { dispose(): void } {
  const noFact = (): never => {
    throw new Error(
      'A failed Native context has no qualified dependency facts.',
    );
  };
  return {
    identity: input.context.id,
    nativeEvidence: failedNativeSnapshot(input, error),
    getContributionFileNames: () => [],
    getImportRecords: () => [],
    getTypeEnvironmentEntries: () => [],
    hasSourceFile: () => false,
    getDependencyFact: noFact,
    resolveImportRecord: noFact,
    dispose() {
      // Failed collection retained no executable resources.
    },
  };
}
