import type { ResolvedCheckerConfig } from '#config/runner';
import { uniqueCodeUnitSortedStrings as uniqueSortedStrings } from '#utils/collections';
import { toRelativePath } from '#utils/path';

interface CheckerSourceConfigCollectionLike {
  buildModulesBySourcePath: Map<string, { kind: string; path: string }>;
  entryConfigPaths: Set<string>;
}

interface CheckerOwnership {
  checkerNames: string[];
  preset: string;
  sourceConfigPath: string;
}

function getOrCreateOwnership(
  ownershipByKey: Map<string, CheckerOwnership>,
  checker: ResolvedCheckerConfig,
  sourceConfigPath: string,
): CheckerOwnership {
  const key = JSON.stringify([checker.preset, sourceConfigPath]);
  const existing = ownershipByKey.get(key);

  if (existing) {
    return existing;
  }

  const created = {
    checkerNames: [],
    preset: checker.preset,
    sourceConfigPath,
  };
  ownershipByKey.set(key, created);
  return created;
}

function collectCheckerOwnership(options: {
  checker: ResolvedCheckerConfig;
  collection: CheckerSourceConfigCollectionLike | undefined;
  ownershipByKey: Map<string, CheckerOwnership>;
}): void {
  if (!options.collection) {
    return;
  }

  for (const sourceConfigPath of options.collection.buildModulesBySourcePath.keys()) {
    getOrCreateOwnership(
      options.ownershipByKey,
      options.checker,
      sourceConfigPath,
    ).checkerNames.push(options.checker.name);
  }
}

function formatDuplicateOwnershipProblem(options: {
  checkerNames: readonly string[];
  ownership: CheckerOwnership;
  rootDir: string;
}): string {
  return [
    'Duplicate Limina checker ownership:',
    `  preset: ${options.ownership.preset}`,
    `  source config: ${toRelativePath(options.rootDir, options.ownership.sourceConfigPath)}`,
    `  checkers: ${options.checkerNames.join(', ')}`,
    '  reason: checkers with the same preset must not govern the same source tsconfig after solution references are expanded.',
    '  fix: narrow config.checkers.<checker>.include or config.checkers.<checker>.exclude so only one checker owns this tsconfig for the preset.',
  ].join('\n');
}

function addDuplicateOwnershipProblem(options: {
  ownership: CheckerOwnership;
  problems: string[];
  rootDir: string;
}): void {
  const checkerNames = uniqueSortedStrings(options.ownership.checkerNames);

  if (checkerNames.length > 1) {
    options.problems.push(
      formatDuplicateOwnershipProblem({
        checkerNames,
        ownership: options.ownership,
        rootDir: options.rootDir,
      }),
    );
  }
}

export function addDuplicateCheckerOwnershipProblems(options: {
  checkerCollectionsByName: Map<string, CheckerSourceConfigCollectionLike>;
  checkers: ResolvedCheckerConfig[];
  problems: string[];
  rootDir: string;
}): void {
  const ownershipByKey = new Map<string, CheckerOwnership>();

  for (const checker of options.checkers) {
    collectCheckerOwnership({
      checker,
      collection: options.checkerCollectionsByName.get(checker.name),
      ownershipByKey,
    });
  }

  for (const ownership of ownershipByKey.values()) {
    addDuplicateOwnershipProblem({
      ownership,
      problems: options.problems,
      rootDir: options.rootDir,
    });
  }
}

function getCheckerNames(
  checkerNamesByEntryPath: ReadonlyMap<string, string[]>,
  entryConfigPath: string,
): string[] {
  return checkerNamesByEntryPath.get(entryConfigPath) ?? [];
}

function collectCheckerEntryNames(options: {
  checker: ResolvedCheckerConfig;
  checkerNamesByEntryPath: Map<string, string[]>;
  collection: CheckerSourceConfigCollectionLike | undefined;
}): void {
  if (!options.collection) {
    return;
  }

  for (const entryConfigPath of options.collection.entryConfigPaths) {
    const names = getCheckerNames(
      options.checkerNamesByEntryPath,
      entryConfigPath,
    );
    options.checkerNamesByEntryPath.set(entryConfigPath, [
      ...names,
      options.checker.name,
    ]);
  }
}

function addOverlappingEntryProblem(options: {
  checkerNames: readonly string[];
  entryConfigPath: string;
  problems: string[];
  rootDir: string;
}): void {
  const names = uniqueSortedStrings(options.checkerNames);

  if (names.length > 1) {
    options.problems.push(
      [
        'Duplicate Limina checker entry:',
        `  entry config: ${toRelativePath(options.rootDir, options.entryConfigPath)}`,
        `  checkers: ${names.join(', ')}`,
        '  reason: checker.include/checker.exclude entry sets must not overlap; capability overlap is allowed only after tsconfig.json references are expanded.',
        '  fix: narrow config.checkers.<checker>.include or config.checkers.<checker>.exclude so each tsconfig.json entry belongs to one checker.',
      ].join('\n'),
    );
  }
}

export function addOverlappingCheckerEntryProblems(options: {
  checkerCollectionsByName: Map<string, CheckerSourceConfigCollectionLike>;
  checkers: ResolvedCheckerConfig[];
  problems: string[];
  rootDir: string;
}): void {
  const checkerNamesByEntryPath = new Map<string, string[]>();

  for (const checker of options.checkers) {
    collectCheckerEntryNames({
      checker,
      checkerNamesByEntryPath,
      collection: options.checkerCollectionsByName.get(checker.name),
    });
  }

  for (const [entryConfigPath, checkerNames] of checkerNamesByEntryPath) {
    addOverlappingEntryProblem({
      checkerNames,
      entryConfigPath,
      problems: options.problems,
      rootDir: options.rootDir,
    });
  }
}

export {
  addUnsupportedSourceConfigExtensionProblems,
  type SourceProjectLike,
} from './source-extension-validation';
