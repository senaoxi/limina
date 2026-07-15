import type {
  ResolvedCheckerConfig,
  ResolvedLiminaConfig,
} from '#config/runner';
import {
  normalizeAbsolutePath,
  toPosixPath,
  toRelativePath,
} from '#utils/path';
import path from 'node:path';
import rawPicomatch from 'picomatch';
import { escapePath } from 'tinyglobby';
import { isDefaultSourceTsconfigPath } from '../build-graph/generated/config-readers';

const parentDirectoryPattern = /^(?:\/?\.\.)+/u;
const escapingBackslashes = /\\(?=[()[\]{}!*+?@|])/gu;

const picomatch = rawPicomatch as unknown as (
  pattern: string,
  options: {
    dot: boolean;
    nobrace: boolean;
    nocase: boolean;
    noextglob: boolean;
    noglobstar: boolean;
    posix: boolean;
  },
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

interface ProcessedExcludePatterns {
  negative: string[];
  positive: string[];
}

function normalizeWorkspaceGlob(value: string): string {
  return value.trim();
}

function normalizeTinyglobbyPattern(pattern: string, cwd: string): string {
  let result = pattern;

  if (result.endsWith('/')) {
    result = result.slice(0, -1);
  }

  const escapedCwd = escapePath(toPosixPath(cwd));
  result = path.isAbsolute(result.replaceAll(escapingBackslashes, ''))
    ? path.posix.relative(escapedCwd, result)
    : path.posix.normalize(result);

  const parentDirectory = parentDirectoryPattern.exec(result)?.[0];

  if (!parentDirectory) {
    return result;
  }

  const parentCount = (parentDirectory.length + 1) / 3;
  const parts = result.split('/');
  const cwdParts = escapedCwd.split('/');
  let matchedParents = 0;

  while (
    matchedParents < parentCount &&
    parts[matchedParents + parentCount] ===
      cwdParts[cwdParts.length + matchedParents - parentCount]
  ) {
    const matchedPart = parts[matchedParents + parentCount]!;
    result =
      result.slice(0, (parentCount - matchedParents - 1) * 3) +
        result.slice(
          (parentCount - matchedParents) * 3 + matchedPart.length + 1,
        ) || '.';
    matchedParents += 1;
  }

  return result;
}

function expandTinyglobbyPattern(pattern: string): string[] {
  if (!pattern || pattern.endsWith('*')) {
    return [pattern];
  }

  // tinyglobby expands directories while still matching an exact file path.
  // The crawler supplies that exact-path behavior; the in-memory matcher must
  // represent both forms explicitly.
  return [pattern, `${pattern}/**`];
}

function processExcludePatterns(
  rootDir: string,
  patterns: readonly string[],
): ProcessedExcludePatterns {
  const processed: ProcessedExcludePatterns = {
    negative: [],
    positive: [],
  };

  for (const value of patterns) {
    const pattern = normalizeWorkspaceGlob(value);

    if (!pattern) {
      continue;
    }

    if (pattern[0] !== '!' || pattern[1] === '(') {
      processed.positive.push(
        ...expandTinyglobbyPattern(
          normalizeTinyglobbyPattern(pattern, rootDir),
        ),
      );
      continue;
    }

    if (pattern[1] !== '!' || pattern[2] === '(') {
      processed.negative.push(
        ...expandTinyglobbyPattern(
          normalizeTinyglobbyPattern(pattern.slice(1), rootDir),
        ),
      );
    }
  }

  return processed;
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

  const matcherOptions = {
    dot: false,
    nobrace: false,
    nocase: false,
    noextglob: false,
    noglobstar: false,
    posix: true,
  } as const;
  const positiveMatchers = patterns.positive.map((pattern) =>
    picomatch(pattern, matcherOptions),
  );
  const negativeMatchers = patterns.negative.map((pattern) =>
    picomatch(pattern, matcherOptions),
  );

  return includedEntryPaths.filter((entryPath) => {
    const relativePath = toPosixPath(toRelativePath(config.rootDir, entryPath));
    const isExcluded = positiveMatchers.some((matches) =>
      matches(relativePath),
    );
    const isRestored = negativeMatchers.some((matches) =>
      matches(relativePath),
    );

    return !isExcluded || isRestored;
  });
}

export async function resolveCheckerEntrySelection(
  context: CheckerEntrySelectionContext,
  options: CheckerEntrySelectionOptions,
): Promise<CheckerEntrySelection> {
  const includePatterns = options.include
    .map(normalizeWorkspaceGlob)
    .flatMap((pattern) =>
      expandTinyglobbyPattern(
        normalizeTinyglobbyPattern(pattern, context.config.rootDir),
      ),
    );
  const matcherOptions = {
    dot: false,
    nobrace: false,
    nocase: false,
    noextglob: false,
    noglobstar: false,
    posix: true,
  } as const;
  const includeMatchers = includePatterns.map((pattern) =>
    picomatch(pattern, matcherOptions),
  );
  const discoveredPaths = context.sourceConfigPaths.filter((configPath) => {
    const relativePath = toPosixPath(
      toRelativePath(context.config.rootDir, configPath),
    );
    return includeMatchers.some((matches) => matches(relativePath));
  });
  const includedEntryPaths = [
    ...new Set(discoveredPaths.map(normalizeAbsolutePath)),
  ].sort((left, right) => left.localeCompare(right));
  const invalidEntryPaths = includedEntryPaths.filter(
    (configPath) => !isDefaultSourceTsconfigPath(configPath),
  );

  if (invalidEntryPaths.length > 0) {
    throw new Error(
      [
        'Checker include matched non-entry tsconfig files:',
        `  checker: ${options.checkerName}`,
        ...invalidEntryPaths.map(
          (configPath) =>
            `  - ${toRelativePath(context.config.rootDir, configPath)}`,
        ),
        '  reason: checker.include may only match tsconfig.json entry files; non-standard tsconfig.*.json files become Limina-managed only when referenced from a managed tsconfig.json entry.',
      ].join('\n'),
    );
  }

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
