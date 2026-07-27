import type {
  ReleaseContentHashConfigArgs,
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
  if (packageConfig === undefined) return [];
  return packageConfig.entries ?? [];
}

export function resolveWorkspacePackageOutputDir(
  config: ResolvedLiminaConfig,
  workspacePackage: NamedWorkspacePackage,
): string {
  const configuredEntry = getPackageEntries(config).find(
    (entry) => entry.name === workspacePackage.name,
  );
  if (configuredEntry !== undefined) {
    return path.resolve(config.rootDir, configuredEntry.outDir);
  }
  return path.join(workspacePackage.directory, 'dist');
}

function isIgnoredArtifactHashFile(relativePath: string): boolean {
  if (ARTIFACT_HASH_IGNORED_FILES.has(relativePath)) return true;
  if (relativePath.startsWith('docs/')) return true;
  return relativePath.startsWith('examples/');
}

function getContentHashConfig(config: ResolvedLiminaConfig) {
  const release = config.release;
  return release === undefined ? undefined : release.contentHash;
}

function resolveConfiguredBaselineTag(options: {
  args: ReleaseContentHashConfigArgs;
  configured: unknown;
}): unknown {
  if (typeof options.configured === 'function') {
    return options.configured(options.args);
  }
  if (options.configured === undefined) {
    return DEFAULT_CONTENT_HASH_BASELINE_TAG;
  }
  return options.configured;
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
  args: ReleaseContentHashConfigArgs,
): string {
  const configured = getContentHashConfig(config)?.baselineTag;
  return requireBaselineTag(resolveConfiguredBaselineTag({ args, configured }));
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

function createFallbackRules(enabled: boolean): ContentHashIgnoreRule[] {
  return enabled ? [createBuiltinContentHashIgnoreRule()] : [];
}

function resolveConfiguredIgnore(options: {
  args: ReleaseContentHashConfigArgs;
  configured: NonNullable<
    NonNullable<ResolvedLiminaConfig['release']>['contentHash']
  >['ignore'];
}): unknown {
  if (typeof options.configured === 'function') {
    return options.configured(options.args);
  }
  return options.configured;
}

function resolveIgnoreRules(options: {
  args: ReleaseContentHashConfigArgs;
  configured: NonNullable<
    NonNullable<ResolvedLiminaConfig['release']>['contentHash']
  >['ignore'];
  fallback: ContentHashIgnoreRule[];
}): ContentHashIgnoreRule[] {
  if (options.configured === undefined) return options.fallback;
  const resolved = resolveConfiguredIgnore(options);
  if (resolved === undefined) return options.fallback;
  return createUserContentHashIgnoreRules(
    normalizeReleaseContentHashIgnorePatterns(resolved),
  );
}

export function resolveReleaseContentHashIgnoreRules(
  config: ResolvedLiminaConfig,
  args: ReleaseContentHashConfigArgs,
): ContentHashIgnoreRule[] {
  const contentHash = getContentHashConfig(config);
  if (contentHash === undefined) return [];
  return resolveIgnoreRules({
    args,
    configured: contentHash.ignore,
    fallback: createFallbackRules(contentHash.builtinIgnore === true),
  });
}
