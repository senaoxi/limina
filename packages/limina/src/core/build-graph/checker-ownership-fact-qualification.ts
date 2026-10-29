import { summarizeCompilationObligation } from '../../domain/analysis/native-obligation';
import { qualifiedNativeDependencyTarget } from '../typescript-semantic/native-fact-qualification';
import type {
  CheckerDependencyFact,
  CheckerOwnershipPlan,
} from './checker-ownership-types';
import { isCurrentLockedSupplement } from './pending-supplemental-assessment';

export function assertLockedDependencyFacts(plan: CheckerOwnershipPlan): void {
  if (plan.dependencyFactPhase === 'selection')
    throw new Error(
      'Ownership selection observations cannot drive build coloring or promotion.',
    );
}

/**
Undefined identifies a framework/legacy producer with its own authority.
*/
export function nativeDependencyTarget(
  fact: CheckerDependencyFact,
): string | null | undefined {
  const supplement = fact.supplementalAssessment;
  if (
    supplement !== undefined &&
    isCurrentLockedSupplement(supplement) &&
    summarizeCompilationObligation(supplement.obligation) === 'required'
  )
    return supplement.obligation.targetConfigId;
  const evidence = fact.nativeEvidence;
  return evidence === undefined
    ? undefined
    : qualifiedNativeDependencyTarget(evidence);
}
