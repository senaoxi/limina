import { toRelativePath } from '#utils/path';
import type { CheckerDependencyFact } from './checker-ownership-types';
import type { FileOwnerLookup } from './file-owner-lookup';

export function formatAmbiguousCanonicalOwner(options: {
  filePath: string;
  owners: readonly string[];
  rootDir: string;
}): string {
  return [
    'Ambiguous canonical governed source ownership:',
    `  physical target: ${toRelativePath(options.rootDir, options.filePath)}`,
    '  actual owning configs:',
    ...options.owners.map(
      (owner) => `    - ${toRelativePath(options.rootDir, owner)}`,
    ),
    '  reason: a symlink alias must identify exactly one actual owning config.',
  ].join('\n');
}

export function collectCanonicalOwnerProblems(options: {
  facts: readonly CheckerDependencyFact[];
  membership: FileOwnerLookup;
  rootDir: string;
}): string[] {
  const paths = new Set(
    options.facts.flatMap((fact) =>
      fact.physicalTargetPath === null ? [] : [fact.physicalTargetPath],
    ),
  );
  return [...paths]
    .filter((filePath) => options.membership.isCanonicalAmbiguous(filePath))
    .map((filePath) =>
      formatAmbiguousCanonicalOwner({
        filePath,
        owners: options.membership.get(filePath) ?? [],
        rootDir: options.rootDir,
      }),
    );
}
