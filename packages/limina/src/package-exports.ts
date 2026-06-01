import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ResolvedLiminaConfig } from './config';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  normalizeSlashes,
  normalizeWorkspacePath,
  toPosixPath,
  toRelativePath,
} from './utils/path';
import type { WorkspacePackage } from './workspace';

export const defaultSourceExtensions: string[] = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.d.ts',
  '.d.mts',
  '.d.cts',
];

export const defaultConditionPriority: string[] = [
  'source',
  'development',
  'types',
  'import',
  'module',
  'default',
  'require',
];

export const defaultArtifactDirectories: string[] = [
  'dist',
  'build',
  'lib',
  'esm',
  'cjs',
  'out',
];

export interface PackageExportSourceEntry {
  alias: string;
  exportKey: string;
  target: string;
}

export type SourceFileOwnerLookup = ReadonlyMap<string, readonly string[]>;

export function configuredArtifactDirectories(
  config: ResolvedLiminaConfig,
): string[] {
  return config.paths?.artifactDirectories ?? defaultArtifactDirectories;
}

export function configuredSourceExtensions(
  config: ResolvedLiminaConfig,
): string[] {
  return config.paths?.sourceExtensions ?? defaultSourceExtensions;
}

export function collectTargetCandidates(
  config: ResolvedLiminaConfig,
  value: unknown,
): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }

  const record = value as Record<string, unknown>;
  const candidates: string[] = [];
  const visitedKeys = new Set<string>();

  for (const key of config.paths?.conditionPriority ??
    defaultConditionPriority) {
    if (!(key in record)) {
      continue;
    }

    visitedKeys.add(key);
    candidates.push(...collectTargetCandidates(config, record[key]));
  }

  for (const key of Object.keys(record).sort()) {
    if (visitedKeys.has(key)) {
      continue;
    }

    candidates.push(...collectTargetCandidates(config, record[key]));
  }

  return candidates;
}

export function normalizePackageTarget(target: string): string | null {
  if (!target.startsWith('./')) {
    return null;
  }

  return target.slice(2);
}

export function packageExportKeyToAlias(
  packageName: string,
  exportKey: string,
): string {
  if (exportKey === '.') {
    return packageName;
  }

  if (!exportKey.startsWith('./')) {
    return '';
  }

  return `${packageName}/${exportKey.slice(2)}`;
}

export function removeKnownExtension(filePath: string): string {
  for (const extension of [
    '.d.mts',
    '.d.cts',
    '.d.ts',
    '.mts',
    '.cts',
    '.mjs',
    '.cjs',
    '.js',
    '.tsx',
    '.ts',
  ]) {
    if (filePath.endsWith(extension)) {
      return filePath.slice(0, -extension.length);
    }
  }

  return filePath;
}

export function hasConfiguredSourceExtension(
  config: ResolvedLiminaConfig,
  target: string,
): boolean {
  return configuredSourceExtensions(config).some((extension) =>
    target.endsWith(extension),
  );
}

export function isInsideArtifactDirectory(
  config: ResolvedLiminaConfig,
  target: string,
): boolean {
  const normalizedTarget = normalizeSlashes(target);

  return configuredArtifactDirectories(config).some((directoryName) => {
    const normalizedDirectoryName = normalizeSlashes(directoryName).replace(
      /\/+$/u,
      '',
    );

    return (
      normalizedTarget === normalizedDirectoryName ||
      normalizedTarget.startsWith(`${normalizedDirectoryName}/`)
    );
  });
}

export function isLikelySourceTarget(
  config: ResolvedLiminaConfig,
  target: string,
): boolean {
  return (
    hasConfiguredSourceExtension(config, target) &&
    !isInsideArtifactDirectory(config, target)
  );
}

export function stripArtifactPrefix(
  config: ResolvedLiminaConfig,
  target: string,
): string {
  const normalizedTarget = normalizeSlashes(target);

  for (const directoryName of configuredArtifactDirectories(config)) {
    const normalizedDirectoryName = normalizeSlashes(directoryName).replace(
      /\/+$/u,
      '',
    );

    if (normalizedTarget.startsWith(`${normalizedDirectoryName}/`)) {
      return normalizedTarget.slice(normalizedDirectoryName.length + 1);
    }
  }

  return normalizedTarget;
}

export function sourceFileCandidates(
  config: ResolvedLiminaConfig,
  target: string,
): string[] {
  const normalizedTarget = normalizeSlashes(target);
  const withoutKnownExtension = removeKnownExtension(normalizedTarget);
  const withoutArtifactPrefix = stripArtifactPrefix(config, normalizedTarget);
  const sourceBase = removeKnownExtension(withoutArtifactPrefix);
  const bases =
    withoutArtifactPrefix === normalizedTarget
      ? [
          withoutKnownExtension,
          sourceBase,
          `src/${sourceBase}`,
          `${sourceBase}/index`,
          `src/${sourceBase}/index`,
        ]
      : [
          sourceBase,
          `src/${sourceBase}`,
          `${sourceBase}/index`,
          `src/${sourceBase}/index`,
        ];
  const candidates: string[] = [];

  for (const base of bases) {
    for (const extension of configuredSourceExtensions(config)) {
      candidates.push(`${base}${extension}`);
    }
  }

  return [...new Set(candidates)];
}

export function wildcardBaseDirectory(pattern: string): string {
  const wildcardIndex = pattern.indexOf('*');
  const prefix =
    wildcardIndex === -1 ? pattern : pattern.slice(0, wildcardIndex);
  const lastSlashIndex = prefix.lastIndexOf('/');

  return lastSlashIndex === -1 ? '.' : prefix.slice(0, lastSlashIndex);
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function createWildcardPatternMatcher(pattern: string): RegExp {
  return new RegExp(
    `^${normalizeSlashes(pattern).split('*').map(escapeRegExp).join('.*')}$`,
    'u',
  );
}

function hasOwnedSourceFileMatchingPattern(options: {
  packageDirectory: string;
  sourceFileOwnerLookup: SourceFileOwnerLookup;
  target: string;
}): boolean {
  const matcher = createWildcardPatternMatcher(options.target);

  for (const filePath of options.sourceFileOwnerLookup.keys()) {
    if (!isPathInsideDirectory(filePath, options.packageDirectory)) {
      continue;
    }

    const packageRelativePath = toPosixPath(
      path.relative(options.packageDirectory, filePath),
    );

    if (matcher.test(packageRelativePath)) {
      return true;
    }
  }

  return false;
}

export function sourceWildcardPatternCandidates(
  config: ResolvedLiminaConfig,
  target: string,
): string[] {
  const strippedPattern = stripArtifactPrefix(config, target);
  const sourcePattern = removeKnownExtension(strippedPattern);
  const preferSrcPrefix = strippedPattern !== normalizeSlashes(target);
  const candidates: string[] = [];

  for (const extension of configuredSourceExtensions(config)) {
    if (preferSrcPrefix) {
      candidates.push(
        `src/${sourcePattern}${extension}`,
        `${sourcePattern}${extension}`,
      );
    } else {
      candidates.push(
        `${sourcePattern}${extension}`,
        `src/${sourcePattern}${extension}`,
      );
    }
  }

  return [...new Set(candidates)];
}

export function resolveWildcardTarget(
  config: ResolvedLiminaConfig,
  packageDirectory: string,
  target: string,
): string | null {
  const sourcePatterns = sourceWildcardPatternCandidates(config, target);
  const candidatePatterns = isLikelySourceTarget(config, target)
    ? [target, ...sourcePatterns]
    : sourcePatterns;

  for (const candidatePattern of candidatePatterns) {
    const baseDirectory = wildcardBaseDirectory(candidatePattern);

    if (existsSync(path.join(packageDirectory, baseDirectory))) {
      return toPosixPath(
        path.join(
          toRelativePath(config.rootDir, packageDirectory),
          candidatePattern,
        ),
      );
    }
  }

  return null;
}

export function resolveExactTarget(
  config: ResolvedLiminaConfig,
  packageDirectory: string,
  target: string,
): string | null {
  const absoluteTarget = path.join(packageDirectory, target);

  if (existsSync(absoluteTarget) && isLikelySourceTarget(config, target)) {
    return normalizeWorkspacePath(config.rootDir, absoluteTarget);
  }

  for (const candidate of sourceFileCandidates(config, target)) {
    const absoluteCandidate = path.join(packageDirectory, candidate);

    if (existsSync(absoluteCandidate)) {
      return normalizeWorkspacePath(config.rootDir, absoluteCandidate);
    }
  }

  return null;
}

export function resolvePackageTarget(
  config: ResolvedLiminaConfig,
  packageDirectory: string,
  rawTarget: string,
): string | null {
  const target = normalizePackageTarget(rawTarget);

  if (!target) {
    return null;
  }

  if (target.includes('*')) {
    return resolveWildcardTarget(config, packageDirectory, target);
  }

  return resolveExactTarget(config, packageDirectory, target);
}

export function resolveDirectSourcePackageTarget(
  config: ResolvedLiminaConfig,
  packageDirectory: string,
  rawTarget: string,
  sourceFileOwnerLookup: SourceFileOwnerLookup,
): string | null {
  const target = normalizePackageTarget(rawTarget);

  if (!target || isInsideArtifactDirectory(config, target)) {
    return null;
  }

  if (target.includes('*')) {
    const baseDirectory = wildcardBaseDirectory(target);

    return existsSync(path.join(packageDirectory, baseDirectory)) &&
      hasOwnedSourceFileMatchingPattern({
        packageDirectory,
        sourceFileOwnerLookup,
        target,
      })
      ? toPosixPath(
          path.join(toRelativePath(config.rootDir, packageDirectory), target),
        )
      : null;
  }

  const absoluteTarget = normalizeAbsolutePath(
    path.join(packageDirectory, target),
  );

  return existsSync(absoluteTarget) && sourceFileOwnerLookup.has(absoluteTarget)
    ? normalizeWorkspacePath(config.rootDir, absoluteTarget)
    : null;
}

export function isPackageJsonMetadataExport(
  exportKey: string,
  candidates: string[],
): boolean {
  return (
    exportKey === './package.json' &&
    candidates.length > 0 &&
    candidates.every(
      (candidate) => normalizePackageTarget(candidate) === 'package.json',
    )
  );
}

export function collectExportEntries(
  config: ResolvedLiminaConfig,
  workspacePackage: WorkspacePackage,
): [string, string][] {
  const exportsField = workspacePackage.manifest.exports;

  if (!exportsField) {
    return [];
  }

  const exportEntries =
    typeof exportsField === 'object' &&
    exportsField !== null &&
    !Array.isArray(exportsField) &&
    Object.keys(exportsField).some((key) => key.startsWith('.'))
      ? Object.entries(exportsField as Record<string, unknown>)
      : [['.', exportsField] as const];
  const entries: [string, string][] = [];

  for (const [exportKey, exportValue] of exportEntries.sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const alias = packageExportKeyToAlias(workspacePackage.name, exportKey);

    if (!alias) {
      continue;
    }

    for (const candidate of collectTargetCandidates(config, exportValue)) {
      const resolvedTarget = resolvePackageTarget(
        config,
        workspacePackage.directory,
        candidate,
      );

      if (resolvedTarget) {
        entries.push([alias, resolvedTarget]);
        break;
      }
    }
  }

  return entries;
}

export function collectStrictSourceExportEntries(options: {
  config: ResolvedLiminaConfig;
  problems: string[];
  sourceFileOwnerLookup: SourceFileOwnerLookup;
  workspacePackage: WorkspacePackage;
}): PackageExportSourceEntry[] {
  const exportsField = options.workspacePackage.manifest.exports;

  if (!exportsField) {
    return [];
  }

  const exportEntries =
    typeof exportsField === 'object' &&
    exportsField !== null &&
    !Array.isArray(exportsField) &&
    Object.keys(exportsField).some((key) => key.startsWith('.'))
      ? Object.entries(exportsField as Record<string, unknown>)
      : [['.', exportsField] as const];
  const entries: PackageExportSourceEntry[] = [];

  for (const [exportKey, exportValue] of exportEntries.sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const alias = packageExportKeyToAlias(
      options.workspacePackage.name,
      exportKey,
    );

    if (!alias) {
      continue;
    }

    const candidates = collectTargetCandidates(options.config, exportValue);

    if (isPackageJsonMetadataExport(exportKey, candidates)) {
      continue;
    }

    let target: string | null = null;
    for (const candidate of candidates) {
      target = resolveDirectSourcePackageTarget(
        options.config,
        options.workspacePackage.directory,
        candidate,
        options.sourceFileOwnerLookup,
      );

      if (target) {
        break;
      }
    }

    if (!target) {
      options.problems.push(
        [
          'Workspace package export must point directly to source:',
          `  package: ${options.workspacePackage.name}`,
          `  export: ${exportKey}`,
          `  package directory: ${toRelativePath(options.config.rootDir, options.workspacePackage.directory)}`,
          `  candidates: ${candidates.length > 0 ? candidates.join(', ') : '(none)'}`,
          '  reason: strict: true requires workspace package exports to expose source files so project references and bundlers can model source dependency edges.',
        ].join('\n'),
      );
      continue;
    }

    entries.push({
      alias,
      exportKey,
      target,
    });
  }

  return entries;
}

export function aliasMatchesSpecifier(
  alias: string,
  specifier: string,
): boolean {
  if (alias === specifier) {
    return true;
  }

  const wildcardIndex = alias.indexOf('*');

  if (wildcardIndex === -1) {
    return false;
  }

  const prefix = alias.slice(0, wildcardIndex);
  const suffix = alias.slice(wildcardIndex + 1);

  return specifier.startsWith(prefix) && specifier.endsWith(suffix);
}

export function resolveExportTargetForSpecifier(
  entry: PackageExportSourceEntry,
  specifier: string,
): string | null {
  if (entry.alias === specifier) {
    return entry.target;
  }

  const wildcardIndex = entry.alias.indexOf('*');
  const targetWildcardIndex = entry.target.indexOf('*');

  if (wildcardIndex === -1 || targetWildcardIndex === -1) {
    return null;
  }

  const prefix = entry.alias.slice(0, wildcardIndex);
  const suffix = entry.alias.slice(wildcardIndex + 1);

  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
    return null;
  }

  const matchedValue = specifier.slice(
    prefix.length,
    specifier.length - suffix.length,
  );

  return `${entry.target.slice(0, targetWildcardIndex)}${matchedValue}${entry.target.slice(
    targetWildcardIndex + 1,
  )}`;
}
