import ignore from 'ignore';
import { existsSync, readFileSync } from 'node:fs';
import path from 'pathe';
import rawPicomatch from 'picomatch';

import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  toPosixPath,
  toRelativePath,
} from '#utils/path';
import {
  collectActivatedPackageFileCandidates,
  createCandidateGlobMatcher,
} from '../core/workspace/file-candidates';
import type { ValidatedWorkspaceContext } from '../core/workspace/validated-context';

const DEFAULT_SOURCE_TOKEN = '...' as const;

const defaultSourceInclude = [
  '**/*.ts',
  '**/*.tsx',
  '**/*.d.ts',
  '**/*.cts',
  '**/*.d.cts',
  '**/*.mts',
  '**/*.d.mts',
] as const;

const defaultSourceExclude = [
  'node_modules',
  'bower_components',
  'jspm_packages',
] as const;

interface ExpandedSourcePatterns {
  patterns: string[];
  usesDefaultBundle: boolean;
}

function uniquePatterns(patterns: readonly string[]): string[] {
  const seen = new Set<string>();

  return patterns.filter((pattern) => {
    if (seen.has(pattern)) {
      return false;
    }

    seen.add(pattern);
    return true;
  });
}

function expandDefaultToken(options: {
  configured: readonly string[] | undefined;
  defaults: readonly string[];
}): ExpandedSourcePatterns {
  if (options.configured === undefined) {
    return {
      patterns: [...options.defaults],
      usesDefaultBundle: true,
    };
  }

  const usesDefaultBundle = options.configured.includes(DEFAULT_SOURCE_TOKEN);
  const expanded = options.configured.flatMap((pattern) =>
    pattern === DEFAULT_SOURCE_TOKEN ? options.defaults : [pattern],
  );

  return {
    patterns: uniquePatterns(expanded),
    usesDefaultBundle,
  };
}

function hasGlobSyntax(pattern: string): boolean {
  return /[*?[\]{}()!+@]/u.test(pattern);
}

function isDirectoryShorthand(pattern: string): boolean {
  return (
    !hasGlobSyntax(pattern) && !pattern.includes('/') && !path.extname(pattern)
  );
}

function expandPlainSourceExcludePattern(normalized: string): string[] {
  return normalized.includes('/')
    ? [normalized, `${normalized}/**`]
    : [normalized, `**/${normalized}`];
}

function normalizeNonEmptySourceExcludePattern(normalized: string): string[] {
  if (isDirectoryShorthand(normalized)) {
    return [`${normalized}/**`, `**/${normalized}/**`];
  }

  if (hasGlobSyntax(normalized)) {
    return [normalized];
  }

  return expandPlainSourceExcludePattern(normalized);
}

function normalizeSourceExcludePattern(pattern: string): string[] {
  const normalized = pattern.replaceAll('\\', '/').replace(/\/+$/u, '');
  return normalized ? normalizeNonEmptySourceExcludePattern(normalized) : [];
}

function normalizeExactDirectoryExcludePattern(pattern: string): string[] {
  const normalized = pattern.replaceAll('\\', '/').replace(/\/+$/u, '');

  return normalized ? [normalized, `${normalized}/**`] : [];
}

function collectDefaultSourceExcludePatterns(options: {
  config: ResolvedLiminaConfig;
  outputRoots?: readonly string[];
}): string[] {
  const staticExcludes = defaultSourceExclude.flatMap(
    normalizeSourceExcludePattern,
  );
  const outputExcludes = (options.outputRoots ?? []).flatMap((outDir) => {
    return normalizeExactDirectoryExcludePattern(
      toPosixPath(toRelativePath(options.config.rootDir, outDir)),
    );
  });

  return uniquePatterns([...staticExcludes, ...outputExcludes]);
}

function expandSourceExcludePatterns(options: {
  configured: readonly string[] | undefined;
  defaults: readonly string[];
}): ExpandedSourcePatterns {
  if (options.configured === undefined) {
    return {
      patterns: [...options.defaults],
      usesDefaultBundle: true,
    };
  }

  const usesDefaultBundle = options.configured.includes(DEFAULT_SOURCE_TOKEN);
  const expanded = options.configured.flatMap((pattern) =>
    pattern === DEFAULT_SOURCE_TOKEN
      ? options.defaults
      : normalizeSourceExcludePattern(pattern),
  );

  return {
    patterns: uniquePatterns(expanded),
    usesDefaultBundle,
  };
}

function createGitignoreFilter(
  config: ResolvedLiminaConfig,
): ((filePath: string) => boolean) | null {
  const gitignorePath = path.join(config.rootDir, '.gitignore');

  if (!existsSync(gitignorePath)) {
    return null;
  }

  const matcher = ignore().add(readFileSync(gitignorePath, 'utf8'));

  return (filePath) =>
    matcher.ignores(toPosixPath(toRelativePath(config.rootDir, filePath)));
}

function getConfiguredSourcePatterns(config: ResolvedLiminaConfig): {
  exclude?: readonly string[];
  include?: readonly string[];
} {
  return config.config?.source ?? {};
}

function createExcludeMatchers(
  patterns: readonly string[],
): ((value: string) => boolean)[] {
  const matcherOptions = { dot: true } as const;
  const createMatcher = rawPicomatch as unknown as (
    pattern: string,
    options: { dot: boolean },
  ) => (value: string) => boolean;

  return patterns.map((pattern) => createMatcher(pattern, matcherOptions));
}

function isSelectedSourceCandidate(options: {
  configRootDir: string;
  excludeMatchers: readonly ((value: string) => boolean)[];
  filePath: string;
  includeMatcher: (value: string) => boolean;
}): boolean {
  const relativePath = toPosixPath(
    toRelativePath(options.configRootDir, options.filePath),
  );
  const isExcluded = options.excludeMatchers.some((matches) =>
    matches(relativePath),
  );

  return options.includeMatcher(relativePath) && !isExcluded;
}

function isVisibleThroughGitignore(options: {
  configRootDir: string;
  filePath: string;
  gitignoreFilter: ((filePath: string) => boolean) | null;
}): boolean {
  if (!isPathInsideDirectory(options.filePath, options.configRootDir)) {
    return true;
  }

  return options.gitignoreFilter === null
    ? true
    : !options.gitignoreFilter(options.filePath);
}

function createOptionalGitignoreFilter(
  config: ResolvedLiminaConfig,
  usesDefaultBundle: boolean,
): ((filePath: string) => boolean) | null {
  return usesDefaultBundle ? createGitignoreFilter(config) : null;
}

export async function collectExpectedSourceFiles(
  config: ResolvedLiminaConfig,
  _generatedGraph: GeneratedTsconfigGraphResult,
  workspaceContext: ValidatedWorkspaceContext,
): Promise<Set<string>> {
  const configured = getConfiguredSourcePatterns(config);
  const include = expandDefaultToken({
    configured: configured.include,
    defaults: defaultSourceInclude,
  });
  const exclude = expandSourceExcludePatterns({
    configured: configured.exclude,
    defaults: collectDefaultSourceExcludePatterns({
      config,
      outputRoots: workspaceContext.outputRoots,
    }),
  });
  const gitignoreFilter = createOptionalGitignoreFilter(
    config,
    exclude.usesDefaultBundle,
  );
  const candidates =
    await collectActivatedPackageFileCandidates(workspaceContext);
  const includeMatcher = createCandidateGlobMatcher(include.patterns);
  const excludeMatchers = createExcludeMatchers(exclude.patterns);
  const configRootDir = normalizeAbsolutePath(config.rootDir);

  return new Set(
    candidates
      .filter((filePath) =>
        isSelectedSourceCandidate({
          configRootDir,
          excludeMatchers,
          filePath,
          includeMatcher,
        }),
      )
      .filter((filePath) =>
        isVisibleThroughGitignore({
          configRootDir,
          filePath,
          gitignoreFilter,
        }),
      )
      .sort(),
  );
}
