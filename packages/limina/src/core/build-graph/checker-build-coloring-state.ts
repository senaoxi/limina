import type { CheckerName } from '#config/runner';
import type { TypeConfigOwnershipState } from './checker-ownership-types';
import { getUniqueConstraint } from './checker-solution-constraints';

export function getKnownBuildColor(
  state: TypeConfigOwnershipState,
): CheckerName | undefined {
  if (state.localOwner.kind === 'resolved') return state.localOwner.checker;
  return getUniqueConstraint(state);
}

export function isBuildColoringCandidate(
  state: TypeConfigOwnershipState,
  isBuildChecker: (checker: CheckerName) => boolean,
): boolean {
  const checker = getKnownBuildColor(state);
  return checker === undefined || isBuildChecker(checker);
}
