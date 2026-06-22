import ignore from 'ignore';
import { existsSync, readFileSync } from 'node:fs';
import path from 'pathe';
import { glob } from 'tinyglobby';

import { getCheckerExtensions, normalizeExtensions } from '#checkers';
import {
  getActiveCheckers,
  isAutoCheckerConfigMode,
  type ResolvedLiminaConfig,
} from '#config/runner';
import { createExtensionPattern } from '#core/tsconfig/actions';
import {
  normalizeAbsolutePath,
  toPosixPath,
  toRelativePath,
} from '#utils/path';

const defaultSourceIncludeExtensions = [
  '.ts',
  '.d.ts',
  '.tsx',
  '.cts',
  '.d.cts',
  '.mts',
  '.d.mts',
  '.mjs',
  '.json',
];
const defaultSourceIncludeExtensionSet = new Set<string>(
  defaultSourceIncludeExtensions,
);
const defaultSourceExclude = [
  'nx.json',
  'project.json',
  'tsconfig.json',
  '**/tsconfig.*.json',
  'dist',
  '.nx',
  '.git',
  '.tsbuild',
  'coverage',
  'node_modules',
];

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

function defaultSourceExtensions(config: ResolvedLiminaConfig): string[] {
  const activeCheckers = getActiveCheckers(config);
  const autoCheckerExtensions =
    config.config?.checkers === undefined ||
    isAutoCheckerConfigMode(config.config.checkers)
      ? getCheckerExtensions(
          {
            include: [],
            preset: 'vue-tsc',
          },
          {
            projectRootDir: config.rootDir,
          },
        )
      : [];
  const checkerExtensions = normalizeExtensions([
    ...activeCheckers.flatMap((checker) => checker.extensions),
    ...autoCheckerExtensions,
  ]).filter((extension) => !defaultSourceIncludeExtensionSet.has(extension));

  return [...defaultSourceIncludeExtensions, ...checkerExtensions];
}

function sourceIncludePatterns(config: ResolvedLiminaConfig): string[] {
  if (config.config?.source?.include) {
    return config.config.source.include;
  }

  return defaultSourceExtensions(config).map((extension) => `**/*${extension}`);
}

function sourceExcludePatterns(config: ResolvedLiminaConfig): string[] {
  return (config.config?.source?.exclude ?? defaultSourceExclude).flatMap(
    normalizeSourceExcludePattern,
  );
}

function createGitignoreFilter(
  config: ResolvedLiminaConfig,
): ((filePath: string) => boolean) | null {
  if (config.config?.source?.exclude !== undefined) {
    return null;
  }

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
): Promise<Set<string>> {
  const explicitInclude = config.config?.source?.include !== undefined;
  const proofFilePattern = explicitInclude
    ? null
    : createExtensionPattern(defaultSourceExtensions(config));
  const gitignoreFilter = createGitignoreFilter(config);
  const files = await glob(sourceIncludePatterns(config), {
    cwd: config.rootDir,
    absolute: true,
    ignore: sourceExcludePatterns(config),
    onlyFiles: true,
  });

  return new Set(
    files
      .map(normalizeAbsolutePath)
      .filter((filePath) => proofFilePattern?.test(filePath) ?? true)
      .filter((filePath) => !gitignoreFilter?.(filePath))
      .sort(),
  );
}
