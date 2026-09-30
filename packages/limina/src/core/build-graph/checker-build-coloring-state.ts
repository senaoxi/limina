import type { CheckerName } from '#config/runner';
import type { TypeConfigOwnershipState } from './checker-ownership-types';
import { getUniqueConstraint } from './checker-solution-constraints';

export function getKnownBuildColor(
  state: TypeConfigOwnershipState,
): CheckerName | undefined {
  return state.localOwner.kind === 'resolved'
    ? state.localOwner.checker
    : getUniqueConstraint(state);
}

export function isBuildColoringCandidate(
  state: TypeConfigOwnershipState,
  isBuildChecker: (checker: CheckerName) => boolean,
): boolean {
  const checker = getKnownBuildColor(state);
  return checker === undefined || isBuildChecker(checker);
}
