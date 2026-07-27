import type {
  ResolvedCheckerConfig,
  ResolvedLiminaConfig,
} from '#config/runner';
import {
  normalizeAbsolutePath,
  toPosixPath,
  toRelativePath,
} from '#utils/path';
import rawPicomatch from 'picomatch';
import { isDefaultSourceTsconfigPath } from '../build-graph/generated/config-readers';
import {
  expandTinyglobbyPattern,
  normalizeTinyglobbyPattern,
  normalizeWorkspaceGlob,
  processExcludePatterns,
} from './entry-patterns';

const matcherOptions = {
  dot: false,
  nobrace: false,
  nocase: false,
  noextglob: false,
  noglobstar: false,
  posix: true,
} as const;

const picomatch = rawPicomatch as unknown as (
  pattern: string,
  options: typeof matcherOptions,
) => (value: string) => boolean;

export interface CheckerEntrySelection {
  effectiveEntryPaths: string[];
  includedEntryPaths: string[];
}

export interface CheckerEntrySelectionContext {
  config: ResolvedLiminaConfig;
  sourceConfigPaths: readonly string[];
}

export interface CheckerEntrySelectionOptions {
  checkerName: string;
  exclude: readonly string[];
  include: readonly string[];
}

function createMatchers(
  patterns: readonly string[],
): ((value: string) => boolean)[] {
  return patterns.map((pattern) => picomatch(pattern, matcherOptions));
}

function isExcludedEntry(options: {
  config: ResolvedLiminaConfig;
  entryPath: string;
  negativeMatchers: readonly ((value: string) => boolean)[];
  positiveMatchers: readonly ((value: string) => boolean)[];
}): boolean {
  const relativePath = toPosixPath(
    toRelativePath(options.config.rootDir, options.entryPath),
  );
  const excluded = options.positiveMatchers.some((matches) =>
    matches(relativePath),
  );
  const restored = options.negativeMatchers.some((matches) =>
    matches(relativePath),
  );

  return excluded && !restored;
}

function filterExcludedEntries(
  config: ResolvedLiminaConfig,
  includedEntryPaths: readonly string[],
  excludePatterns: readonly string[],
): string[] {
  const patterns = processExcludePatterns(config.rootDir, excludePatterns);

  if (patterns.positive.length === 0) {
    return [...includedEntryPaths];
  }

  const positiveMatchers = createMatchers(patterns.positive);
  const negativeMatchers = createMatchers(patterns.negative);

  return includedEntryPaths.filter(
    (entryPath) =>
      !isExcludedEntry({
        config,
        entryPath,
        negativeMatchers,
        positiveMatchers,
      }),
  );
}

function createIncludePatterns(
  rootDir: string,
  patterns: readonly string[],
): string[] {
  return patterns
    .map(normalizeWorkspaceGlob)
    .flatMap((pattern) =>
      expandTinyglobbyPattern(normalizeTinyglobbyPattern(pattern, rootDir)),
    );
}

function matchesAnyPattern(
  configPath: string,
  rootDir: string,
  matchers: readonly ((value: string) => boolean)[],
): boolean {
  const relativePath = toPosixPath(toRelativePath(rootDir, configPath));
  return matchers.some((matches) => matches(relativePath));
}

function collectIncludedEntryPaths(
  context: CheckerEntrySelectionContext,
  includePatterns: readonly string[],
): string[] {
  const matchers = createMatchers(includePatterns);
  const discoveredPaths = context.sourceConfigPaths.filter((configPath) =>
    matchesAnyPattern(configPath, context.config.rootDir, matchers),
  );

  return [...new Set(discoveredPaths.map(normalizeAbsolutePath))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function formatInvalidEntryError(options: {
  checkerName: string;
  invalidEntryPaths: readonly string[];
  rootDir: string;
}): string {
  return [
    'Checker include matched non-entry tsconfig files:',
    `  checker: ${options.checkerName}`,
    ...options.invalidEntryPaths.map(
      (configPath) => `  - ${toRelativePath(options.rootDir, configPath)}`,
    ),
    '  reason: checker.include may only match tsconfig.json entry files; non-standard tsconfig.*.json files become Limina-managed only when referenced from a managed tsconfig.json entry.',
  ].join('\n');
}

function assertValidEntryPaths(options: {
  checkerName: string;
  entryPaths: readonly string[];
  rootDir: string;
}): void {
  const invalidEntryPaths = options.entryPaths.filter(
    (configPath) => !isDefaultSourceTsconfigPath(configPath),
  );

  if (invalidEntryPaths.length > 0) {
    throw new Error(
      formatInvalidEntryError({
        checkerName: options.checkerName,
        invalidEntryPaths,
        rootDir: options.rootDir,
      }),
    );
  }
}

export async function resolveCheckerEntrySelection(
  context: CheckerEntrySelectionContext,
  options: CheckerEntrySelectionOptions,
): Promise<CheckerEntrySelection> {
  const includePatterns = createIncludePatterns(
    context.config.rootDir,
    options.include,
  );
  const includedEntryPaths = collectIncludedEntryPaths(
    context,
    includePatterns,
  );

  assertValidEntryPaths({
    checkerName: options.checkerName,
    entryPaths: includedEntryPaths,
    rootDir: context.config.rootDir,
  });

  return {
    effectiveEntryPaths: filterExcludedEntries(
      context.config,
      includedEntryPaths,
      options.exclude,
    ),
    includedEntryPaths,
  };
}

export function createCheckerEntrySelectionOptions(
  checker: ResolvedCheckerConfig,
): CheckerEntrySelectionOptions {
  return {
    checkerName: checker.name,
    exclude: checker.exclude,
    include: checker.include,
  };
}
