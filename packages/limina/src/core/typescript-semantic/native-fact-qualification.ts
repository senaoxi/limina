import {
  type NativeEvidenceContext,
  qualifyNativeEvidence,
} from '../../domain/analysis/native-context';
import type { NativeCoverage } from '../../domain/analysis/native-coverage';
import { summarizeCompilationObligation } from '../../domain/analysis/native-obligation';
import type { NativeDependencyFact } from './dependency-fact';

type Evidence = NonNullable<NativeDependencyFact['nativeEvidence']>;

/**
Context freshness must already have been established by collection/restore.
*/
export function qualifiedNativeDependencyTarget(
  evidence: Evidence,
): string | null {
  return qualifyNativeEvidence(
    evidence.origin,
    evidence.origin.context,
    'locked-fact',
  ).eligible
    ? obligationTarget(evidence.obligation)
    : null;
}
function obligationTarget(obligation: Evidence['obligation']): string | null {
  if (obligation === null) return null;
  return ['required', 'already-satisfied'].includes(
    summarizeCompilationObligation(obligation),
  )
    ? obligation.targetConfigId
    : null;
}
function hasQualifiedCoverage(
  coverage: NativeCoverage | null,
  target: string,
): boolean {
  if (coverage === null) return false;
  return [
    coverage.state === 'unique',
    coverage.completeness === 'complete',
    coverage.target.physical.state === 'verified',
    coverage.members[0]?.configId === target,
  ].every(Boolean);
}
/**
Qualification does not assert obligation existence. Necessary unknowns retain their target.
*/
export function qualifiedNativeEvidenceTarget(
  evidence: Evidence,
  current: NativeEvidenceContext,
): string | null {
  return qualifyNativeEvidence(evidence.origin, current, 'locked-fact').eligible
    ? qualifiedCoverageTarget(evidence)
    : null;
}
function qualifiedCoverageTarget(evidence: Evidence): string | null {
  const target = evidenceTarget(evidence);
  if (target == null) return null;
  return hasQualifiedCoverage(evidence.coverage, target) ? target : null;
}

function evidenceTarget(evidence: Evidence): string | null | undefined {
  return evidence.obligation?.targetConfigId;
}
