import { compareCodeUnits } from '#utils/collections';
import type { GeneratedDependencyEdge } from './types';
export function compareDependencyEdges(
  left: GeneratedDependencyEdge,
  right: GeneratedDependencyEdge,
): number {
  const comparisons = [
    compareCodeUnits(left.fromChecker, right.fromChecker),
    compareCodeUnits(left.fromConfigPath, right.fromConfigPath),
    compareCodeUnits(left.toChecker, right.toChecker),
    compareCodeUnits(left.toConfigPath, right.toConfigPath),
    compareCodeUnits(left.file, right.file),
    compareCodeUnits(left.importedSpecifier, right.importedSpecifier),
  ];
  return comparisons.find((comparison) => comparison !== 0) ?? 0;
}
