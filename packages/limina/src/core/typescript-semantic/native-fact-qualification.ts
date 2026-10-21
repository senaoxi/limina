import { qualifyNativeEvidence } from '../../domain/analysis/native-context';
import { summarizeCompilationObligation } from '../../domain/analysis/native-obligation';
import type { NativeDependencyFact } from './dependency-fact';

/**
Context freshness must already have been established by collection/restore.
*/
export function qualifiedNativeDependencyTarget(
  evidence: NonNullable<NativeDependencyFact['nativeEvidence']>,
): string | null {
  const eligible = qualifyNativeEvidence(
    evidence.origin,
    evidence.origin.context,
    'locked-fact',
  );
  return eligible.eligible ? obligationTarget(evidence.obligation) : null;
}

function obligationTarget(
  obligation: NonNullable<NativeDependencyFact['nativeEvidence']>['obligation'],
): string | null {
  if (obligation === null) return null;
  return ['required', 'already-satisfied'].includes(
    summarizeCompilationObligation(obligation),
  )
    ? obligation.targetConfigId
    : null;
}
