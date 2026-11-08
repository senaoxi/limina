import { toRelativePath } from '#utils/path';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import type { CheckerDependencyFact } from './checker-ownership-types';
import type { FileOwnerLookup } from './file-owner-lookup';

export function formatAmbiguousCanonicalOwner(options: {
  filePath: string;
  owners: readonly string[];
  rootDir: string;
}): string {
  return [
    'Ambiguous compiler input ownership:',
    `  compiler target: ${toRelativePath(options.rootDir, options.filePath)}`,
    '  actual owning configs:',
    ...options.owners.map(
      (owner) => `    - ${toRelativePath(options.rootDir, owner)}`,
    ),
    '  reason: an implementation input must identify exactly one owning config.',
  ].join('\n');
}

export function collectCanonicalOwnerProblems(options: {
  facts: readonly CheckerDependencyFact[];
  membership: FileOwnerLookup;
  rootDir: string;
}): string[] {
  const native = options.facts.flatMap((fact) =>
    nativeAmbiguityProblem(fact, options.rootDir),
  );
  return [...new Set(native)];
}

function nativeAmbiguityProblem(
  fact: CheckerDependencyFact,
  rootDirectory: string,
): string[] {
  const coverage = fact.nativeEvidence?.coverage;
  return coverage == null
    ? []
    : ambiguousCoverageProblems(coverage, rootDirectory);
}

function ambiguousCoverageProblems(
  coverage: NonNullable<
    NonNullable<CheckerDependencyFact['nativeEvidence']>['coverage']
  >,
  rootDirectory: string,
): string[] {
  return coverage.state === 'ambiguous' &&
    !isDeclarationFile(coverage.target.lexicalPath)
    ? [
        formatAmbiguousCanonicalOwner({
          filePath: coverage.target.lexicalPath,
          owners: coverage.members.map((member) => member.configId),
          rootDir: rootDirectory,
        }),
      ]
    : [];
}
