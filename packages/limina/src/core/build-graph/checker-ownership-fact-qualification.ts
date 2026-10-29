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

/**
Only a qualified declaration relation may contribute an execution-color edge.
*/
export function declarationDependencyTarget(
  fact: CheckerDependencyFact,
  membership: { get(path: string): string[] | undefined },
): string | null {
  if (fact.referenceRequirement == null) return null;
  const native = nativeDependencyTarget(fact);
  if (native !== undefined) return native;
  if (fact.physicalTargetPath === null) return null;
  const owners = membership.get(fact.physicalTargetPath);
  return owners?.length === 1 ? owners[0]! : null;
}
