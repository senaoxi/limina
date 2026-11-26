import { freezeNativeData } from '../../domain/analysis/native-evidence-freeze';
import type { ImportRecord } from '../import-analysis/records';
import type { NativeDependencyFact } from './dependency-fact';

/** The graph reads the observed effect and the original occurrence together.
 * The context retains ownership of its mutable compatibility records. */
export interface NativeFileRequest {
  record: ImportRecord;
  evidence: NonNullable<NativeDependencyFact['nativeEvidence']>;
  target: string | undefined;
  referenceRequirement: NativeDependencyFact['referenceRequirement'];
  typeEvidence: NativeDependencyFact['typeEvidence'];
  expansion: boolean;
}

export function nativeFileRequest(
  record: ImportRecord,
  fact: NativeDependencyFact,
): NativeFileRequest {
  if (!fact.nativeEvidence)
    throw new Error('Native occurrence lacks bound compiler evidence.');
  return {
    record: structuredClone(record),
    evidence: freezeNativeData(fact.nativeEvidence),
    target: fact.resolution.target?.resolvedFileName,
    referenceRequirement: fact.referenceRequirement && {
      ...fact.referenceRequirement,
    },
    typeEvidence: structuredClone(fact.typeEvidence),
    expansion: fact.eligibility?.expansion !== false,
  };
}
