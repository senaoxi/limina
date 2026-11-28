import type {
  CheckerConfigMode,
  CheckerName,
  CheckerScope,
} from '../config/pipeline-checker-types';

export function getNamedCheckerConfigs(
  checkers: CheckerConfigMode | undefined,
): Partial<Record<CheckerName, CheckerScope>> {
  if (checkers === undefined) return {};
  const named = { ...checkers };
  delete named.auto;
  return named;
}
