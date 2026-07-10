import ignore from 'ignore';
import { existsSync, readFileSync } from 'node:fs';
import path from 'pathe';
import { glob } from 'tinyglobby';

import type { ResolvedLiminaConfig } from '#config/runner';
import {
  collectGeneratedSourceConfigPaths,
  type GeneratedTsconfigGraphResult,
} from '#core/build-graph/runner';
import { readJsonConfig } from '#core/tsconfig/actions';
import {
  normalizeAbsolutePath,
  toPosixPath,
  toRelativePath,
} from '#utils/path';
import { isPlainRecord } from '#utils/values';
import type { WorkspacePackage } from '../core/workspace/actions';
import {
  createWorkspaceRegionBoundaryIgnorePatterns,
  isVisibleCurrentRegionSourcePath,
  type WorkspaceRegionBoundary,
} from '../core/workspace/regions';

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

function readExplicitOutputOutDir(options: {
  config: ResolvedLiminaConfig;
  sourceConfigPath: string;
}): string | null {
  const configObject = readJsonConfig(options.config, options.sourceConfigPath);
  const liminaOptions = configObject.liminaOptions;

  if (!isPlainRecord(liminaOptions)) {
    return null;
  }

  const outputs = liminaOptions.outputs;

  if (!isPlainRecord(outputs)) {
    return null;
  }

  const outDir = outputs.outDir;

  if (typeof outDir !== 'string' || outDir.trim().length === 0) {
    return null;
  }

  if (path.isAbsolute(outDir)) {
    return null;
  }

  return normalizeAbsolutePath(
    path.resolve(path.dirname(options.sourceConfigPath), outDir.trim()),
  );
}

function collectDefaultSourceExcludePatterns(options: {
  config: ResolvedLiminaConfig;
  generatedGraph: GeneratedTsconfigGraphResult;
}): string[] {
  const staticExcludes = defaultSourceExclude.flatMap(
    normalizeSourceExcludePattern,
  );
  const outputExcludes = collectGeneratedSourceConfigPaths(
    options.generatedGraph,
  ).flatMap((sourceConfigPath) => {
    const outDir = readExplicitOutputOutDir({
      config: options.config,
      sourceConfigPath,
    });

    if (!outDir) {
      return [];
    }

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
  generatedGraph: GeneratedTsconfigGraphResult,
  workspacePackages: readonly WorkspacePackage[],
  regionBoundaries: readonly WorkspaceRegionBoundary[],
): Promise<Set<string>> {
  const include = expandDefaultToken({
    configured: config.config?.source?.include,
    defaults: defaultSourceInclude,
  });
  const exclude = expandSourceExcludePatterns({
    configured: config.config?.source?.exclude,
    defaults: collectDefaultSourceExcludePatterns({
      config,
      generatedGraph,
    }),
  });
  const gitignoreFilter = exclude.usesDefaultBundle
    ? createGitignoreFilter(config)
    : null;
  const files = await glob(include.patterns, {
    cwd: config.rootDir,
    absolute: true,
    ignore: [
      ...exclude.patterns,
      ...createWorkspaceRegionBoundaryIgnorePatterns(
        config,
        regionBoundaries,
        workspacePackages,
      ),
    ],
    onlyFiles: true,
  });

  return new Set(
    files
      .map(normalizeAbsolutePath)
      .filter((filePath) => !gitignoreFilter?.(filePath))
      .filter((filePath) =>
        isVisibleCurrentRegionSourcePath({
          boundaries: regionBoundaries,
          filePath,
          packages: workspacePackages,
          rootDir: config.rootDir,
        }),
      )
      .sort(),
  );
}
