import type { NativeEvidenceFailure } from '../../domain/analysis/native-evidence';
import { AnalysisInputDriftError } from '../analysis-cache/contracts';
import { nativeFingerprint } from './native-file-identity';

export class NativeObservationError extends Error {
  readonly kind: NativeEvidenceFailure['kind'];

  constructor(kind: NativeEvidenceFailure['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

export function nativeFailure(options: {
  contextId: string;
  kind: NativeEvidenceFailure['kind'];
  detail: string;
  entryIds?: readonly string[];
}): NativeEvidenceFailure {
  const { contextId, detail, kind } = options;
  return {
    id: nativeFingerprint(options),
    kind,
    detail,
    evidenceIds: options.entryIds ?? [contextId],
    affected:
      options.entryIds === undefined
        ? { kind: 'contexts', contextIds: [contextId] }
        : { kind: 'entries', contextId, entryIds: options.entryIds },
  };
}

export function observationErrorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function initializeNativeCompiler<T>(initialize: () => T): T {
  try {
    return initialize();
  } catch (error) {
    if (error instanceof NativeObservationError) throw error;
    throw new NativeObservationError(
      initializationFailureKind(error),
      observationErrorDetail(error),
    );
  }
}

export function nativeObservationFailureKind(
  error: unknown,
): NativeEvidenceFailure['kind'] {
  if (error instanceof AnalysisInputDriftError) return 'input-drift';
  return error instanceof NativeObservationError ? error.kind : 'internal';
}

function initializationFailureKind(
  error: unknown,
): NativeEvidenceFailure['kind'] {
  return error instanceof AnalysisInputDriftError
    ? 'input-drift'
    : 'compiler-initialization';
}
