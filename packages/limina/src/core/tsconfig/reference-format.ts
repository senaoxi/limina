import { compareCodeUnits } from '#utils/collections';
import { toRelativePath } from '#utils/path';

export function formatReferences(
  rootDirectory: string,
  references: Set<string>,
): string {
  return references.size === 0
    ? '(none)'
    : [...references]
        .sort(compareCodeUnits)
        .map((value) => toRelativePath(rootDirectory, value))
        .join(', ');
}
