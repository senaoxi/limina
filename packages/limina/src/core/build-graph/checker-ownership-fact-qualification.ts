import { qualifiedNativeDependencyTarget } from '../typescript-semantic/native-fact-qualification';
import type {
  CheckerDependencyFact,
  CheckerOwnershipPlan,
} from './checker-ownership-types';

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
  const evidence = fact.nativeEvidence;
  return evidence === undefined
    ? undefined
    : qualifiedNativeDependencyTarget(evidence);
}
