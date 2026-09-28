import { compareCodeUnits } from '#utils/collections';
import type { GeneratedDependencyEdge } from './types';

function firstNonZero(comparisons: readonly number[]): number {
  return comparisons.find((comparison) => comparison !== 0) ?? 0;
}

export function compareDependencyEdges(
  left: GeneratedDependencyEdge,
  right: GeneratedDependencyEdge,
): number {
  return firstNonZero([
    compareCodeUnits(left.kind, right.kind),
    compareCodeUnits(left.fromChecker, right.fromChecker),
    compareCodeUnits(left.fromConfigPath, right.fromConfigPath),
    compareCodeUnits(left.toChecker, right.toChecker),
    compareCodeUnits(left.toConfigPath, right.toConfigPath),
    compareCodeUnits(left.file, right.file),
    compareCodeUnits(left.importedSpecifier, right.importedSpecifier),
    compareCodeUnits(left.resolvedFilePath, right.resolvedFilePath),
  ]);
}
