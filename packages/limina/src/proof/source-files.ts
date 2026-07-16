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

function normalizeSourceExcludePattern(pattern: string): string[] {
  const normalized = pattern.replaceAll('\\', '/').replace(/\/+$/u, '');

  if (!normalized) {
    return [];
  }

  if (isDirectoryShorthand(normalized)) {
    return [`${normalized}/**`, `**/${normalized}/**`];
  }

  if (hasGlobSyntax(normalized)) {
    return [normalized];
  }

  if (normalized.includes('/')) {
    return [normalized, `${normalized}/**`];
  }

  return [normalized, `**/${normalized}`];
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

export async function collectExpectedSourceFiles(
  config: ResolvedLiminaConfig,
  _generatedGraph: GeneratedTsconfigGraphResult,
  workspaceContext: ValidatedWorkspaceContext,
): Promise<Set<string>> {
  const include = expandDefaultToken({
    configured: config.config?.source?.include,
    defaults: defaultSourceInclude,
  });
  const exclude = expandSourceExcludePatterns({
    configured: config.config?.source?.exclude,
    defaults: collectDefaultSourceExcludePatterns({
      config,
      outputRoots: workspaceContext.outputRoots,
    }),
  });
  const gitignoreFilter = exclude.usesDefaultBundle
    ? createGitignoreFilter(config)
    : null;
  // Public source selectors filter the island-local universe; they never
  // become traversal roots (especially for ../ selectors).
  const candidates =
    await collectActivatedPackageFileCandidates(workspaceContext);
  const matcherOptions = { dot: true } as const;
  const includeMatcher = createCandidateGlobMatcher(include.patterns);
  const excludeMatchers = exclude.patterns.map((pattern) =>
    (
      rawPicomatch as unknown as (
        pattern: string,
        options: { dot: boolean },
      ) => (value: string) => boolean
    )(pattern, matcherOptions),
  );
  const configRootDir = normalizeAbsolutePath(config.rootDir);

  return new Set(
    candidates
      .filter((filePath) => {
        const relativePath = toPosixPath(
          toRelativePath(configRootDir, filePath),
        );
        return (
          includeMatcher(relativePath) &&
          !excludeMatchers.some((matches) => matches(relativePath))
        );
      })
      .filter(
        (filePath) =>
          !isPathInsideDirectory(filePath, configRootDir) ||
          !gitignoreFilter?.(filePath),
      )
      .sort(),
  );
}
