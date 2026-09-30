import type {
  ReleaseContentHashConfigArguments,
  ResolvedLiminaConfig,
} from '#config/runner';
import type { NamedWorkspacePackage } from '#core/workspace/actions';
import path from 'pathe';
import rawPicomatch from 'picomatch';
import type { ContentHashIgnoreRule } from '../consistency/types';

const picomatch = rawPicomatch as unknown as (
  pattern: string | readonly string[],
  options?: { dot?: boolean },
) => (value: string) => boolean;
const DEFAULT_CONTENT_HASH_BASELINE_TAG = 'latest';
const ARTIFACT_HASH_IGNORED_FILES = new Set([
  'README',
  'README.md',
  'CHANGELOG.md',
  'HISTORY.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
]);

function getPackageEntries(config: ResolvedLiminaConfig) {
  const packageConfig = config.package;
  return packageConfig === undefined ? [] : (packageConfig.entries ?? []);
}

export function resolveWorkspacePackageOutputDirectory(
  config: ResolvedLiminaConfig,
  workspacePackage: NamedWorkspacePackage,
): string {
  const configuredEntry = getPackageEntries(config).find(
    (entry) => entry.name === workspacePackage.name,
  );
  return configuredEntry === undefined
    ? path.join(workspacePackage.directory, 'dist')
    : path.resolve(config.rootDir, configuredEntry.outDir);
}

function isIgnoredArtifactHashFile(relativePath: string): boolean {
  return (
    ARTIFACT_HASH_IGNORED_FILES.has(relativePath) ||
    relativePath.startsWith('docs/') ||
    relativePath.startsWith('examples/')
  );
}

function getContentHashConfig(config: ResolvedLiminaConfig) {
  const release = config.release;
  return release === undefined ? undefined : release.contentHash;
}

function resolveConfiguredBaselineTag(options: {
  args: ReleaseContentHashConfigArguments;
  configured: unknown;
}): unknown {
  if (typeof options.configured === 'function') {
    return options.configured(options.args);
  }
  return options.configured === undefined
    ? DEFAULT_CONTENT_HASH_BASELINE_TAG
    : options.configured;
}

function requireBaselineTag(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError(
      'release.contentHash.baselineTag must resolve to a non-empty string',
    );
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TypeError(
      'release.contentHash.baselineTag must resolve to a non-empty string',
    );
  }
  return normalized;
}

export function resolveReleaseContentHashBaselineTag(
  config: ResolvedLiminaConfig,
  arguments_: ReleaseContentHashConfigArguments,
): string {
  const configured = getContentHashConfig(config)?.baselineTag;
  return requireBaselineTag(
    resolveConfiguredBaselineTag({ args: arguments_, configured }),
  );
}

function normalizeIgnorePattern(pattern: unknown, index: number): string {
  if (typeof pattern !== 'string') {
    throw new TypeError(
      `release.contentHash.ignore[${index}] must resolve to a non-empty string`,
    );
  }
  if (pattern.trim().length === 0) {
    throw new TypeError(
      `release.contentHash.ignore[${index}] must resolve to a non-empty string`,
    );
  }
  return pattern.trim();
}

function normalizeReleaseContentHashIgnorePatterns(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(
      'release.contentHash.ignore must resolve to an array of non-empty strings or undefined',
    );
  }
  return value.map(normalizeIgnorePattern);
}

function createUserContentHashIgnoreRules(
  patterns: readonly string[],
): ContentHashIgnoreRule[] {
  return patterns.map((pattern) => ({
    label: `user "${pattern}"`,
    matches: picomatch(pattern, { dot: true }),
  }));
}

function createBuiltinContentHashIgnoreRule(): ContentHashIgnoreRule {
  return { label: 'builtin', matches: isIgnoredArtifactHashFile };
}

function createFallbackRules(isEnabled: boolean): ContentHashIgnoreRule[] {
  return isEnabled ? [createBuiltinContentHashIgnoreRule()] : [];
}

function resolveConfiguredIgnore(options: {
  args: ReleaseContentHashConfigArguments;
  configured: NonNullable<
    NonNullable<ResolvedLiminaConfig['release']>['contentHash']
  >['ignore'];
}): unknown {
  return typeof options.configured === 'function'
    ? options.configured(options.args)
    : options.configured;
}

function resolveIgnoreRules(options: {
  args: ReleaseContentHashConfigArguments;
  configured: NonNullable<
    NonNullable<ResolvedLiminaConfig['release']>['contentHash']
  >['ignore'];
  fallback: ContentHashIgnoreRule[];
}): ContentHashIgnoreRule[] {
  if (options.configured === undefined) return options.fallback;
  const resolved = resolveConfiguredIgnore(options);
  return resolved === undefined
    ? options.fallback
    : createUserContentHashIgnoreRules(
        normalizeReleaseContentHashIgnorePatterns(resolved),
      );
}

export function resolveReleaseContentHashIgnoreRules(
  config: ResolvedLiminaConfig,
  arguments_: ReleaseContentHashConfigArguments,
): ContentHashIgnoreRule[] {
  const contentHash = getContentHashConfig(config);
  if (contentHash === undefined) return [];
  return resolveIgnoreRules({
    args: arguments_,
    configured: contentHash.ignore,
    fallback: createFallbackRules(contentHash.builtinIgnore === true),
  });
}
