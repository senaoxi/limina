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
  const legacy = [...paths]
    .filter((filePath) => options.membership.isCanonicalAmbiguous(filePath))
    .map((filePath) =>
      formatAmbiguousCanonicalOwner({
        filePath,
        owners: options.membership.get(filePath) ?? [],
        rootDir: options.rootDir,
      }),
    );
  const native = options.facts.flatMap((fact) =>
    nativeAmbiguityProblem(fact, options.rootDir),
  );
  return [...new Set([...legacy, ...native])];
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
