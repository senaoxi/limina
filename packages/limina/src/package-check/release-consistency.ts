import type {
  ReleaseContentHashConfigArgs,
  ResolvedLiminaConfig,
} from '#config/runner';
import {
  collectWorkspacePackages,
  getPublishDependencySections,
  isLocalPackageDependencySpecifier,
  isNamedWorkspacePackage,
  isWorkspaceDependencySpecifier,
  type NamedWorkspacePackage,
  type PackageManifest,
  type PublishDependencySectionName,
} from '#core/workspace/actions';
import { toRelativePath } from '#utils/path';
import { isPlainRecord } from '#utils/values';
import { unpack } from '@publint/pack';
import { NpmPackageJsonLint } from 'npm-package-json-lint';
import path from 'pathe';
import rawPicomatch from 'picomatch';
import semver from 'semver';
import { formatErrorMessage, ReleaseLogger } from '../logger';
import { type PackedPackageTarball, packOutputTarball } from './runner';

interface NpmPackageJsonLintIssue {
  lintId: string;
  lintMessage: string;
  node: string;
  severity: string;
}

interface PublishDependencyEntry {
  dependencyName: string;
  sectionName: PublishDependencySectionName;
  specifier: string;
}

type PackageDependencySectionName =
  | PublishDependencySectionName
  | 'devDependencies';

interface PackageDependencyEntry {
  dependencyName: string;
  sectionName: PackageDependencySectionName;
  specifier: string;
}

interface PublishManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  private?: boolean;
  version?: string;
}

interface PackedPackageFile {
  data: Uint8Array;
  name: string;
}

interface PackedPackage {
  files: PackedPackageFile[];
  rootDir: string;
}

interface PackedPackageContentFile {
  data: Uint8Array;
  relativePath: string;
}

type ContentHashDiffKind = (typeof CONTENT_HASH_DIFF_KINDS)[number];

interface PackedArtifactContent {
  filesByPath: Map<string, PackedPackageContentFile>;
  packageVersion: string | null;
}

interface ContentHashDiff {
  kind: ContentHashDiffKind;
  relativePath: string;
}

type ContentHashDiffGroup = Record<ContentHashDiffKind, string[]>;

interface ContentHashIgnoreRule {
  label: string;
  matches: (relativePath: string) => boolean;
}

interface IgnoredContentHashDiffGroup {
  diffs: ContentHashDiffGroup;
  label: string;
}

interface WorkspacePackageOutputComparison {
  ignoredDiffGroups: IgnoredContentHashDiffGroup[];
  localVersion: string | null;
  matchesBaseline: boolean;
  releaseRelevantDiffs: ContentHashDiffGroup;
}

interface RegistryVersionMetadata {
  dist?: unknown;
}

interface RegistryPackageMetadata {
  'dist-tags'?: unknown;
  versions?: unknown;
}

interface DirectWorkspaceDependency {
  dependencyName: string;
  sectionName: PublishDependencySectionName;
  targetPackage: NamedWorkspacePackage;
}

interface ReleaseConsistencyProblem {
  dependencyName?: string;
  importerName: string;
  message: string;
  packageName?: string;
  sectionName?: PackageDependencySectionName;
  specifier?: string;
}

interface ReleaseConsistencyState {
  directWorkspaceDependencies: DirectWorkspaceDependency[];
  edges: Map<string, Set<string>>;
  missingWorkspaceDependencies: ReleaseConsistencyProblem[];
  packedManifestLintProblems: ReleaseConsistencyProblem[];
  packedManifestProblems: ReleaseConsistencyProblem[];
  privateWorkspaceDependencies: ReleaseConsistencyProblem[];
  releaseHygieneProblems: ReleaseConsistencyProblem[];
  registryMetadataCache: Map<string, RegistryPackageMetadata | null>;
  registryProblems: ReleaseConsistencyProblem[];
  sourceLinkDependencies: ReleaseConsistencyProblem[];
  unpublishedPackageNames: Set<string>;
  visitedPackages: Set<string>;
}

export interface AssertPackageReleaseConsistencyOptions {
  config: ResolvedLiminaConfig;
  label: string;
  outputManifest: PublishManifest;
  packedTarball: Buffer;
  outDir: string;
}

export class PackageReleaseConsistencyError extends Error {
  override readonly name = 'PackageReleaseConsistencyError';
}

const picomatch = rawPicomatch as unknown as (
  pattern: string | readonly string[],
  options?: {
    dot?: boolean;
  },
) => (value: string) => boolean;
const DEFAULT_CONTENT_HASH_BASELINE_TAG = 'latest';
const CONTENT_HASH_DIFF_KINDS = [
  'local-only',
  'remote-only',
  'changed',
] as const;
const REQUIRED_RELEASE_FILES = ['README.md', 'LICENSE.md'] as const;
const ARTIFACT_HASH_IGNORED_FILES = new Set([
  'README',
  'README.md',
  'CHANGELOG.md',
  'HISTORY.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
]);
const SOURCE_MAPPING_URL_PATTERN =
  /\/\/\s*#\s*sourceMappingURL\s*=|\/\*\s*#\s*sourceMappingURL\s*=/u;
const PACKED_MANIFEST_LINT_CONFIG = {
  rules: {
    'bin-type': 'error',
    'bundledDependencies-type': 'error',
    'config-type': 'error',
    'cpu-type': 'error',
    'dependencies-type': 'error',
    'description-type': 'error',
    'devDependencies-type': 'error',
    'directories-type': 'error',
    'engines-type': 'error',
    'files-type': 'error',
    'homepage-type': 'error',
    'keywords-type': 'error',
    'license-type': 'error',
    'main-type': 'error',
    'man-type': 'error',
    'name-format': 'error',
    'name-type': 'error',
    'no-archive-dependencies': 'error',
    'no-archive-devDependencies': 'error',
    'no-file-dependencies': 'error',
    'no-file-devDependencies': 'error',
    'no-git-dependencies': 'error',
    'no-git-devDependencies': 'error',
    'no-repeated-dependencies': 'error',
    'optionalDependencies-type': 'error',
    'os-type': 'error',
    'peerDependencies-type': 'error',
    'preferGlobal-type': 'error',
    'private-type': 'error',
    'repository-type': 'error',
    'require-license': 'error',
    'require-name': 'error',
    'require-types': 'error',
    'require-version': 'error',
    'scripts-type': 'error',
    'type-type': 'error',
    'valid-values-private': ['error', [false]],
    'version-format': 'error',
    'version-type': 'error',
  },
} as const;

function isLinkDependencySpecifier(specifier: string): boolean {
  return specifier.startsWith('link:');
}

function createReleaseConsistencyState(): ReleaseConsistencyState {
  return {
    directWorkspaceDependencies: [],
    edges: new Map<string, Set<string>>(),
    missingWorkspaceDependencies: [],
    packedManifestLintProblems: [],
    packedManifestProblems: [],
    privateWorkspaceDependencies: [],
    releaseHygieneProblems: [],
    registryMetadataCache: new Map<string, RegistryPackageMetadata | null>(),
    registryProblems: [],
    sourceLinkDependencies: [],
    unpublishedPackageNames: new Set<string>(),
    visitedPackages: new Set<string>(),
  };
}

function collectPublishDependencyEntries(
  manifest: PublishManifest | PackageManifest,
): PublishDependencyEntry[] {
  const entries: PublishDependencyEntry[] = [];

  for (const { dependencies, name } of getPublishDependencySections(manifest)) {
    for (const [dependencyName, specifier] of Object.entries(dependencies)) {
      entries.push({
        dependencyName,
        sectionName: name,
        specifier,
      });
    }
  }

  return entries;
}

function collectPackageDependencyEntries(
  manifest: PublishManifest | PackageManifest,
): PackageDependencyEntry[] {
  const entries: PackageDependencyEntry[] = [];
  const sections: {
    dependencies: Record<string, string> | undefined;
    name: PackageDependencySectionName;
  }[] = [
    {
      dependencies: manifest.dependencies,
      name: 'dependencies',
    },
    {
      dependencies: manifest.devDependencies,
      name: 'devDependencies',
    },
    {
      dependencies: manifest.peerDependencies,
      name: 'peerDependencies',
    },
    {
      dependencies: manifest.optionalDependencies,
      name: 'optionalDependencies',
    },
  ];

  for (const { dependencies, name } of sections) {
    if (!dependencies) {
      continue;
    }

    for (const [dependencyName, specifier] of Object.entries(dependencies)) {
      entries.push({
        dependencyName,
        sectionName: name,
        specifier,
      });
    }
  }

  return entries;
}

function addEdge(
  edges: Map<string, Set<string>>,
  importerName: string,
  dependencyName: string,
): void {
  const dependencies = edges.get(importerName) ?? new Set<string>();
  dependencies.add(dependencyName);
  edges.set(importerName, dependencies);
}

function formatDependencyLocation(problem: ReleaseConsistencyProblem): string {
  const dependency = problem.dependencyName
    ? ` -> ${problem.dependencyName}`
    : '';
  const section = problem.sectionName ? ` [${problem.sectionName}]` : '';
  const specifier = problem.specifier ? ` (${problem.specifier})` : '';

  return `${problem.importerName}${dependency}${section}${specifier}`;
}

function formatProblemLines(
  title: string,
  problems: ReleaseConsistencyProblem[],
): string[] {
  if (problems.length === 0) {
    return [];
  }

  return [
    '',
    title,
    ...problems.map(
      (problem) =>
        `  - ${formatDependencyLocation(problem)}: ${problem.message}`,
    ),
  ];
}

function getPackedDependencySpecifier(
  manifest: PublishManifest,
  dependencyName: string,
): string | undefined {
  for (const { dependencies } of getPublishDependencySections(manifest)) {
    const specifier = dependencies[dependencyName];

    if (specifier) {
      return specifier;
    }
  }

  return undefined;
}

function getNpmPackageMetadataUrl(packageName: string): string {
  return `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;
}

async function fetchRegistryPackageMetadata(
  packageName: string,
  state: ReleaseConsistencyState,
): Promise<RegistryPackageMetadata | null> {
  if (state.registryMetadataCache.has(packageName)) {
    return state.registryMetadataCache.get(packageName) ?? null;
  }

  const response = await fetch(getNpmPackageMetadataUrl(packageName), {
    headers: {
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    state.registryMetadataCache.set(packageName, null);
    return null;
  }

  const metadata = (await response.json()) as unknown;
  const registryMetadata = isPlainRecord(metadata)
    ? (metadata as RegistryPackageMetadata)
    : null;

  state.registryMetadataCache.set(packageName, registryMetadata);
  return registryMetadata;
}

function findRegistryVersionMetadata(
  metadata: RegistryPackageMetadata,
  version: string,
): RegistryVersionMetadata | null {
  if (!isPlainRecord(metadata.versions)) {
    return null;
  }

  const versionMetadata = metadata.versions[version];

  return isPlainRecord(versionMetadata)
    ? (versionMetadata as RegistryVersionMetadata)
    : null;
}

function findRegistryDistTagVersion(
  metadata: RegistryPackageMetadata,
  distTag: string,
): string | null {
  if (!isPlainRecord(metadata['dist-tags'])) {
    return null;
  }

  const version = metadata['dist-tags'][distTag];

  return typeof version === 'string' && version.trim().length > 0
    ? version
    : null;
}

function getRegistryTarballUrl(
  versionMetadata: RegistryVersionMetadata,
): string | null {
  if (!isPlainRecord(versionMetadata.dist)) {
    return null;
  }

  const tarballUrl = versionMetadata.dist.tarball;

  return typeof tarballUrl === 'string' && tarballUrl.trim().length > 0
    ? tarballUrl
    : null;
}

async function fetchRegistryTarball(tarballUrl: string): Promise<Buffer> {
  const response = await fetch(tarballUrl, {
    headers: {
      accept: 'application/octet-stream',
    },
  });

  if (!response.ok) {
    throw new Error(
      `unable to download npm tarball ${tarballUrl}: ${response.status} ${response.statusText}`,
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

function resolveWorkspacePackageOutputDir(
  config: ResolvedLiminaConfig,
  workspacePackage: NamedWorkspacePackage,
): string {
  const configuredEntry = config.package?.entries?.find(
    (entry) => entry.name === workspacePackage.name,
  );

  return configuredEntry
    ? path.resolve(config.rootDir, configuredEntry.outDir)
    : path.join(workspacePackage.directory, 'dist');
}

function isIgnoredArtifactHashFile(relativePath: string): boolean {
  return (
    ARTIFACT_HASH_IGNORED_FILES.has(relativePath) ||
    relativePath.startsWith('docs/') ||
    relativePath.startsWith('examples/')
  );
}

function resolveReleaseContentHashBaselineTag(
  config: ResolvedLiminaConfig,
  args: ReleaseContentHashConfigArgs,
): string {
  const configuredBaselineTag = config.release?.contentHash?.baselineTag;
  const baselineTag =
    typeof configuredBaselineTag === 'function'
      ? configuredBaselineTag(args)
      : (configuredBaselineTag ?? DEFAULT_CONTENT_HASH_BASELINE_TAG);

  if (typeof baselineTag !== 'string' || baselineTag.trim().length === 0) {
    throw new Error(
      'release.contentHash.baselineTag must resolve to a non-empty string',
    );
  }

  return baselineTag.trim();
}

function normalizeReleaseContentHashIgnorePatterns(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(
      'release.contentHash.ignore must resolve to an array of non-empty strings or undefined',
    );
  }

  return value.map((pattern, index) => {
    if (typeof pattern !== 'string' || pattern.trim().length === 0) {
      throw new Error(
        `release.contentHash.ignore[${index}] must resolve to a non-empty string`,
      );
    }

    return pattern.trim();
  });
}

function createUserContentHashIgnoreRules(
  patterns: readonly string[],
): ContentHashIgnoreRule[] {
  return patterns.map((pattern) => {
    const matches = picomatch(pattern, {
      dot: true,
    });

    return {
      label: `user "${pattern}"`,
      matches,
    };
  });
}

function createBuiltinContentHashIgnoreRule(): ContentHashIgnoreRule {
  return {
    label: 'builtin',
    matches: isIgnoredArtifactHashFile,
  };
}

function resolveReleaseContentHashIgnoreRules(
  config: ResolvedLiminaConfig,
  args: ReleaseContentHashConfigArgs,
): ContentHashIgnoreRule[] {
  const contentHash = config.release?.contentHash;
  const configuredIgnore = contentHash?.ignore;
  const useBuiltinFallback = contentHash?.builtinIgnore === true;

  if (configuredIgnore === undefined) {
    return useBuiltinFallback ? [createBuiltinContentHashIgnoreRule()] : [];
  }

  if (typeof configuredIgnore === 'function') {
    const resolvedIgnore = configuredIgnore(args);

    if (resolvedIgnore === undefined) {
      return useBuiltinFallback ? [createBuiltinContentHashIgnoreRule()] : [];
    }

    return createUserContentHashIgnoreRules(
      normalizeReleaseContentHashIgnorePatterns(resolvedIgnore),
    );
  }

  return createUserContentHashIgnoreRules(
    normalizeReleaseContentHashIgnorePatterns(configuredIgnore),
  );
}

function createContentHashDiffGroup(): ContentHashDiffGroup {
  return {
    changed: [],
    'local-only': [],
    'remote-only': [],
  };
}

function addContentHashDiff(
  group: ContentHashDiffGroup,
  diff: ContentHashDiff,
): void {
  group[diff.kind].push(diff.relativePath);
}

function sortContentHashDiffGroup(group: ContentHashDiffGroup): void {
  for (const kind of CONTENT_HASH_DIFF_KINDS) {
    group[kind].sort((a, b) => a.localeCompare(b));
  }
}

function countContentHashDiffs(group: ContentHashDiffGroup): number {
  return CONTENT_HASH_DIFF_KINDS.reduce(
    (count, kind) => count + group[kind].length,
    0,
  );
}

function hasContentHashDiffs(group: ContentHashDiffGroup): boolean {
  return countContentHashDiffs(group) > 0;
}

function readPackedPackageVersion(
  contentFiles: readonly PackedPackageContentFile[],
): string | null {
  const packageJsonFile = contentFiles.find(
    (file) => file.relativePath === 'package.json',
  );

  if (!packageJsonFile) {
    return null;
  }

  try {
    const manifest = JSON.parse(
      Buffer.from(packageJsonFile.data).toString('utf8'),
    ) as unknown;

    if (!isPlainRecord(manifest) || typeof manifest.version !== 'string') {
      return null;
    }

    const version = manifest.version.trim();

    return version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

async function readPackedArtifactContent(
  tarball: Buffer,
): Promise<PackedArtifactContent> {
  const packedPackage = await unpackPackedPackage(tarball);
  const contentFiles = getPackedContentFiles(packedPackage);
  const filesByPath = new Map<string, PackedPackageContentFile>(
    contentFiles.map((file) => [file.relativePath, file]),
  );

  return {
    filesByPath,
    packageVersion: readPackedPackageVersion(contentFiles),
  };
}

function fileDataEquals(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function createContentHashDiffs(options: {
  localArtifact: PackedArtifactContent;
  remoteArtifact: PackedArtifactContent;
}): ContentHashDiff[] {
  const paths = new Set([
    ...options.localArtifact.filesByPath.keys(),
    ...options.remoteArtifact.filesByPath.keys(),
  ]);
  const diffs: ContentHashDiff[] = [];

  for (const relativePath of [...paths].sort((a, b) => a.localeCompare(b))) {
    const localFile = options.localArtifact.filesByPath.get(relativePath);
    const remoteFile = options.remoteArtifact.filesByPath.get(relativePath);

    if (localFile && !remoteFile) {
      diffs.push({
        kind: 'local-only',
        relativePath,
      });
      continue;
    }

    if (!localFile && remoteFile) {
      diffs.push({
        kind: 'remote-only',
        relativePath,
      });
      continue;
    }

    if (
      localFile &&
      remoteFile &&
      !fileDataEquals(localFile.data, remoteFile.data)
    ) {
      diffs.push({
        kind: 'changed',
        relativePath,
      });
    }
  }

  return diffs;
}

function partitionContentHashDiffs(options: {
  diffs: readonly ContentHashDiff[];
  ignoreRules: readonly ContentHashIgnoreRule[];
}): {
  ignoredDiffGroups: IgnoredContentHashDiffGroup[];
  releaseRelevantDiffs: ContentHashDiffGroup;
} {
  const releaseRelevantDiffs = createContentHashDiffGroup();
  const ignoredDiffGroups = options.ignoreRules.map((rule) => ({
    diffs: createContentHashDiffGroup(),
    label: rule.label,
  }));

  for (const diff of options.diffs) {
    const ignoredGroupIndex = options.ignoreRules.findIndex((rule) =>
      rule.matches(diff.relativePath),
    );

    if (ignoredGroupIndex === -1) {
      addContentHashDiff(releaseRelevantDiffs, diff);
      continue;
    }

    addContentHashDiff(ignoredDiffGroups[ignoredGroupIndex].diffs, diff);
  }

  sortContentHashDiffGroup(releaseRelevantDiffs);

  for (const group of ignoredDiffGroups) {
    sortContentHashDiffGroup(group.diffs);
  }

  return {
    ignoredDiffGroups: ignoredDiffGroups.filter((group) =>
      hasContentHashDiffs(group.diffs),
    ),
    releaseRelevantDiffs,
  };
}

function formatReleaseRelevantContentHashDiffs(
  diffs: ContentHashDiffGroup,
): string[] {
  if (!hasContentHashDiffs(diffs)) {
    return [];
  }

  const lines = ['', 'Release-relevant diffs:'];

  for (const kind of CONTENT_HASH_DIFF_KINDS) {
    const paths = diffs[kind];

    if (paths.length === 0) {
      continue;
    }

    lines.push(
      `  ${kind}:`,
      ...paths.map((relativePath) => `    ${relativePath}`),
    );
  }

  return lines;
}

function formatIgnoredContentHashDiffs(
  groups: readonly IgnoredContentHashDiffGroup[],
): string[] {
  if (groups.length === 0) {
    return [];
  }

  const lines = ['', 'Ignored contentHash diffs:'];

  for (const group of groups) {
    lines.push(
      `  ${group.label}:`,
      ...CONTENT_HASH_DIFF_KINDS.map(
        (kind) => `    ${kind}: ${group.diffs[kind].length}`,
      ),
    );
  }

  return lines;
}

function formatContentHashComparisonReport(options: {
  baselineTag: string;
  baselineVersion: string;
  comparison: WorkspacePackageOutputComparison;
  dependencyName: string;
  importerName: string;
  localVersionFallback: string | undefined;
}): string {
  const { comparison, dependencyName } = options;
  const status = comparison.matchesBaseline ? 'PASS' : 'FAIL';
  const localVersion =
    comparison.localVersion ??
    options.localVersionFallback ??
    '(missing version)';
  const lines = [
    `[release-check] ${status} ${options.importerName} -> ${dependencyName}`,
    `Baseline: npm ${options.baselineTag} -> ${dependencyName}@${options.baselineVersion}`,
    `Local: ${dependencyName}@${localVersion}`,
    ...formatReleaseRelevantContentHashDiffs(comparison.releaseRelevantDiffs),
    ...formatIgnoredContentHashDiffs(comparison.ignoredDiffGroups),
  ];

  return lines.join('\n');
}

async function compareLocalWorkspacePackageOutputToBaseline(options: {
  config: ResolvedLiminaConfig;
  ignoreRules: readonly ContentHashIgnoreRule[];
  tarballUrl: string;
  workspacePackage: NamedWorkspacePackage;
}): Promise<WorkspacePackageOutputComparison> {
  let localPackedTarball: PackedPackageTarball | undefined;

  try {
    const localOutDir = resolveWorkspacePackageOutputDir(
      options.config,
      options.workspacePackage,
    );
    const publishedTarball = await fetchRegistryTarball(options.tarballUrl);
    localPackedTarball = await packOutputTarball(localOutDir);

    const [remoteArtifact, localArtifact] = await Promise.all([
      readPackedArtifactContent(publishedTarball),
      readPackedArtifactContent(localPackedTarball.tarball),
    ]);
    const { ignoredDiffGroups, releaseRelevantDiffs } =
      partitionContentHashDiffs({
        diffs: createContentHashDiffs({
          localArtifact,
          remoteArtifact,
        }),
        ignoreRules: options.ignoreRules,
      });

    return {
      ignoredDiffGroups,
      localVersion: localArtifact.packageVersion,
      matchesBaseline: !hasContentHashDiffs(releaseRelevantDiffs),
      releaseRelevantDiffs,
    };
  } finally {
    if (localPackedTarball) {
      await localPackedTarball.cleanup();
    }
  }
}

async function verifyWorkspacePackagePublished(options: {
  config: ResolvedLiminaConfig;
  importerName: string;
  state: ReleaseConsistencyState;
  workspacePackage: NamedWorkspacePackage;
}): Promise<void> {
  const { importerName, state, workspacePackage } = options;
  const dependencyName = workspacePackage.name;
  const problemBase = {
    dependencyName,
    importerName,
    packageName: dependencyName,
  };
  const contentHashArgs = {
    dependencyName,
    importerName,
  };
  let baselineTag: string;
  let ignoreRules: ContentHashIgnoreRule[];

  try {
    baselineTag = resolveReleaseContentHashBaselineTag(
      options.config,
      contentHashArgs,
    );
    ignoreRules = resolveReleaseContentHashIgnoreRules(
      options.config,
      contentHashArgs,
    );
  } catch (error) {
    state.unpublishedPackageNames.add(dependencyName);
    state.registryProblems.push({
      ...problemBase,
      message: [
        `invalid release.contentHash config for ${dependencyName}:`,
        formatErrorMessage(error),
      ].join(' '),
    });
    return;
  }

  let metadata: RegistryPackageMetadata | null;

  try {
    metadata = await fetchRegistryPackageMetadata(dependencyName, state);
  } catch (error) {
    state.unpublishedPackageNames.add(dependencyName);
    state.registryProblems.push({
      ...problemBase,
      message: [
        `unable to read npm registry metadata for ${dependencyName}:`,
        formatErrorMessage(error),
      ].join(' '),
    });
    return;
  }

  if (!metadata) {
    state.unpublishedPackageNames.add(dependencyName);
    state.registryProblems.push({
      ...problemBase,
      message: `${dependencyName} is not published to the npm registry`,
    });
    return;
  }

  const baselineVersion = findRegistryDistTagVersion(metadata, baselineTag);

  if (!baselineVersion) {
    state.unpublishedPackageNames.add(dependencyName);
    state.registryProblems.push({
      ...problemBase,
      message: `${dependencyName} registry metadata has no "${baselineTag}" dist-tag`,
    });
    return;
  }

  const versionMetadata = findRegistryVersionMetadata(
    metadata,
    baselineVersion,
  );

  if (!versionMetadata) {
    state.unpublishedPackageNames.add(dependencyName);
    state.registryProblems.push({
      ...problemBase,
      message: `${dependencyName}@${baselineVersion} is not published to the npm registry`,
    });
    return;
  }

  const tarballUrl = getRegistryTarballUrl(versionMetadata);

  if (!tarballUrl) {
    state.unpublishedPackageNames.add(dependencyName);
    state.registryProblems.push({
      ...problemBase,
      message: `${dependencyName}@${baselineVersion} registry metadata has no dist.tarball`,
    });
    return;
  }

  let comparison: WorkspacePackageOutputComparison;

  try {
    comparison = await compareLocalWorkspacePackageOutputToBaseline({
      config: options.config,
      ignoreRules,
      tarballUrl,
      workspacePackage,
    });
  } catch (error) {
    state.unpublishedPackageNames.add(dependencyName);
    state.registryProblems.push({
      ...problemBase,
      message: [
        `unable to compare local package output for ${dependencyName}`,
        `against npm ${baselineTag} ${dependencyName}@${baselineVersion}:`,
        formatErrorMessage(error),
      ].join(' '),
    });
    return;
  }

  const comparisonReport = formatContentHashComparisonReport({
    baselineTag,
    baselineVersion,
    comparison,
    dependencyName,
    importerName,
    localVersionFallback: workspacePackage.manifest.version,
  });

  if (!comparison.matchesBaseline) {
    state.unpublishedPackageNames.add(dependencyName);
    state.registryProblems.push({
      ...problemBase,
      message: comparisonReport,
    });
    return;
  }

  ReleaseLogger.info(comparisonReport);
}

async function visitWorkspacePackageDependencies(options: {
  config: ResolvedLiminaConfig;
  importerName: string;
  isRoot: boolean;
  manifest: PackageManifest;
  state: ReleaseConsistencyState;
  workspacePackagesByName: Map<string, NamedWorkspacePackage>;
}): Promise<void> {
  const {
    config,
    importerName,
    isRoot,
    manifest,
    state,
    workspacePackagesByName,
  } = options;

  for (const entry of collectPublishDependencyEntries(manifest)) {
    if (isLinkDependencySpecifier(entry.specifier)) {
      state.sourceLinkDependencies.push({
        dependencyName: entry.dependencyName,
        importerName,
        message: 'publishable dependency sections must not use link:',
        sectionName: entry.sectionName,
        specifier: entry.specifier,
      });
      continue;
    }

    if (!isWorkspaceDependencySpecifier(entry.specifier)) {
      continue;
    }

    const targetPackage = workspacePackagesByName.get(entry.dependencyName);

    if (!targetPackage) {
      state.missingWorkspaceDependencies.push({
        dependencyName: entry.dependencyName,
        importerName,
        message:
          'workspace: publish dependency does not match a named workspace package',
        sectionName: entry.sectionName,
        specifier: entry.specifier,
      });
      continue;
    }

    addEdge(state.edges, importerName, targetPackage.name);

    if (isRoot) {
      state.directWorkspaceDependencies.push({
        dependencyName: entry.dependencyName,
        sectionName: entry.sectionName,
        targetPackage,
      });
    }

    if (targetPackage.manifest.private === true) {
      state.privateWorkspaceDependencies.push({
        dependencyName: entry.dependencyName,
        importerName,
        message:
          'publishable packages cannot depend on a private workspace package',
        packageName: targetPackage.name,
        sectionName: entry.sectionName,
        specifier: entry.specifier,
      });
      continue;
    }

    if (!state.visitedPackages.has(targetPackage.name)) {
      state.visitedPackages.add(targetPackage.name);
      await verifyWorkspacePackagePublished({
        config,
        importerName,
        state,
        workspacePackage: targetPackage,
      });
      await visitWorkspacePackageDependencies({
        config,
        importerName: targetPackage.name,
        isRoot: false,
        manifest: targetPackage.manifest,
        state,
        workspacePackagesByName,
      });
    }
  }
}

async function unpackPackedPackage(tarball: Buffer): Promise<PackedPackage> {
  return (await unpack(tarball)) as PackedPackage;
}

function getPackedContentFiles(
  packedPackage: PackedPackage,
): PackedPackageContentFile[] {
  const rootPrefix = `${packedPackage.rootDir}/`;
  const files: PackedPackageContentFile[] = [];

  for (const file of packedPackage.files) {
    if (!file.name.startsWith(rootPrefix)) {
      continue;
    }

    files.push({
      data: file.data,
      relativePath: file.name.slice(rootPrefix.length).replaceAll('\\', '/'),
    });
  }

  return files;
}

function readPackedPackageJson(options: {
  contentFiles: PackedPackageContentFile[];
  rootPackageName: string;
  state: ReleaseConsistencyState;
}): PublishManifest | null {
  const packageJsonFile = options.contentFiles.find(
    (file) => file.relativePath === 'package.json',
  );

  if (!packageJsonFile) {
    options.state.releaseHygieneProblems.push({
      importerName: options.rootPackageName,
      message: 'tarball does not contain package.json',
    });
    return null;
  }

  try {
    return JSON.parse(
      Buffer.from(packageJsonFile.data).toString('utf8'),
    ) as PublishManifest;
  } catch (error) {
    options.state.releaseHygieneProblems.push({
      importerName: options.rootPackageName,
      message: `tarball package.json is not valid JSON: ${formatErrorMessage(
        error,
      )}`,
    });
    return null;
  }
}

function formatNpmPackageJsonLintIssue(issue: NpmPackageJsonLintIssue): string {
  return `${issue.lintId} [${issue.node || 'package.json'}]: ${
    issue.lintMessage
  }`;
}

function validatePackedManifestLint(options: {
  config: ResolvedLiminaConfig;
  manifest: PublishManifest;
  outDir: string;
  rootPackageName: string;
  state: ReleaseConsistencyState;
}): void {
  const lintResult = new NpmPackageJsonLint({
    config: PACKED_MANIFEST_LINT_CONFIG,
    cwd: options.config.rootDir,
    packageJsonFilePath: path.join(options.outDir, 'package.json'),
    packageJsonObject: options.manifest,
  }).lint();

  for (const result of lintResult.results) {
    if (result.errorCount === 0) {
      continue;
    }

    for (const issue of result.issues) {
      if (issue.severity !== 'error') {
        continue;
      }

      options.state.packedManifestLintProblems.push({
        importerName: options.rootPackageName,
        message: formatNpmPackageJsonLintIssue(issue),
      });
    }
  }
}

function isJavaScriptPackageFile(relativePath: string): boolean {
  return /\.(?:cjs|mjs|js)$/u.test(relativePath);
}

function validateReleaseTarballHygiene(options: {
  contentFiles: PackedPackageContentFile[];
  rootPackageName: string;
  state: ReleaseConsistencyState;
}): void {
  const filePaths = new Set(
    options.contentFiles.map((file) => file.relativePath),
  );
  const missingReleaseFiles = REQUIRED_RELEASE_FILES.filter(
    (fileName) => !filePaths.has(fileName),
  );

  if (missingReleaseFiles.length > 0) {
    options.state.releaseHygieneProblems.push({
      importerName: options.rootPackageName,
      message: `tarball is missing required file(s): ${missingReleaseFiles.join(
        ', ',
      )}`,
    });
  }

  for (const file of options.contentFiles) {
    if (/\.map$/u.test(file.relativePath)) {
      options.state.releaseHygieneProblems.push({
        importerName: options.rootPackageName,
        message: `tarball contains source map file: ${file.relativePath}`,
      });
      continue;
    }

    if (!isJavaScriptPackageFile(file.relativePath)) {
      continue;
    }

    const source = Buffer.from(file.data).toString('utf8');

    if (SOURCE_MAPPING_URL_PATTERN.test(source)) {
      options.state.releaseHygieneProblems.push({
        importerName: options.rootPackageName,
        message: `tarball JavaScript file contains sourceMappingURL directive: ${file.relativePath}`,
      });
    }
  }
}

function validatePackedManifest(options: {
  manifest: PublishManifest;
  rootPackageName: string;
  state: ReleaseConsistencyState;
}): void {
  const { manifest, rootPackageName, state } = options;

  for (const entry of collectPublishDependencyEntries(manifest)) {
    if (
      isWorkspaceDependencySpecifier(entry.specifier) ||
      isLinkDependencySpecifier(entry.specifier)
    ) {
      state.packedManifestProblems.push({
        dependencyName: entry.dependencyName,
        importerName: rootPackageName,
        message:
          'packed package manifest must not expose workspace: or link: dependency specifiers',
        sectionName: entry.sectionName,
        specifier: entry.specifier,
      });
    }
  }

  for (const entry of collectPackageDependencyEntries(manifest)) {
    if (!isLocalPackageDependencySpecifier(entry.specifier)) {
      continue;
    }

    const isAlreadyCoveredPublishSpecifier =
      entry.sectionName !== 'devDependencies' &&
      (isWorkspaceDependencySpecifier(entry.specifier) ||
        isLinkDependencySpecifier(entry.specifier));

    if (isAlreadyCoveredPublishSpecifier) {
      continue;
    }

    state.packedManifestProblems.push({
      dependencyName: entry.dependencyName,
      importerName: rootPackageName,
      message:
        'packed package manifest must not expose workspace:, link:, file:, or catalog: dependency specifiers in any dependency section',
      sectionName: entry.sectionName,
      specifier: entry.specifier,
    });
  }

  for (const dependency of state.directWorkspaceDependencies) {
    const packedSpecifier = getPackedDependencySpecifier(
      manifest,
      dependency.dependencyName,
    );

    if (!packedSpecifier) {
      state.packedManifestProblems.push({
        dependencyName: dependency.dependencyName,
        importerName: rootPackageName,
        message:
          'packed package manifest must keep every source workspace publish dependency',
        sectionName: dependency.sectionName,
      });
      continue;
    }

    if (
      isWorkspaceDependencySpecifier(packedSpecifier) ||
      isLinkDependencySpecifier(packedSpecifier)
    ) {
      continue;
    }

    const targetVersion = dependency.targetPackage.manifest.version;

    if (
      !targetVersion ||
      !semver.satisfies(targetVersion, packedSpecifier, {
        includePrerelease: true,
      })
    ) {
      state.packedManifestProblems.push({
        dependencyName: dependency.dependencyName,
        importerName: rootPackageName,
        message: `packed dependency range must include ${
          dependency.targetPackage.name
        }@${targetVersion ?? '(missing version)'}`,
        sectionName: dependency.sectionName,
        specifier: packedSpecifier,
      });
    }
  }
}

function createPublishOrder(
  rootPackageName: string,
  state: ReleaseConsistencyState,
): string[] {
  const publishOrder: string[] = [];
  const seen = new Set<string>();

  function visit(packageName: string): void {
    if (seen.has(packageName)) {
      return;
    }

    seen.add(packageName);

    for (const dependencyName of state.edges.get(packageName) ?? []) {
      visit(dependencyName);
    }

    if (
      packageName === rootPackageName ||
      state.unpublishedPackageNames.has(packageName)
    ) {
      publishOrder.push(packageName);
    }
  }

  visit(rootPackageName);
  return publishOrder;
}

function createReleaseConsistencyError(options: {
  config: ResolvedLiminaConfig;
  label: string;
  outDir: string;
  rootPackageName: string;
  state: ReleaseConsistencyState;
}): PackageReleaseConsistencyError | null {
  const { config, label, outDir, rootPackageName, state } = options;
  const problemCount =
    state.sourceLinkDependencies.length +
    state.privateWorkspaceDependencies.length +
    state.missingWorkspaceDependencies.length +
    state.registryProblems.length +
    state.releaseHygieneProblems.length +
    state.packedManifestLintProblems.length +
    state.packedManifestProblems.length;

  if (problemCount === 0) {
    return null;
  }

  const publishOrder = createPublishOrder(rootPackageName, state);
  const lines = [
    `package release check failed for ${label}:`,
    `  output: ${toRelativePath(config.rootDir, outDir)}`,
    ...formatProblemLines(
      'Release tarball is not publishable:',
      state.releaseHygieneProblems,
    ),
    ...formatProblemLines(
      'Source manifest contains local link: publish dependencies:',
      state.sourceLinkDependencies,
    ),
    ...formatProblemLines(
      'Source manifest depends on private workspace packages:',
      state.privateWorkspaceDependencies,
    ),
    ...formatProblemLines(
      'Source manifest has invalid workspace: publish dependencies:',
      state.missingWorkspaceDependencies,
    ),
    ...formatProblemLines(
      'Workspace packages must be published before this package:',
      state.registryProblems,
    ),
    ...formatProblemLines(
      'Packed package manifest failed npm-package-json-lint:',
      state.packedManifestLintProblems,
    ),
    ...formatProblemLines(
      'Packed package manifest is inconsistent with workspace publish dependencies:',
      state.packedManifestProblems,
    ),
  ];

  if (publishOrder.length > 1) {
    lines.push('', `Suggested publish order: ${publishOrder.join(' -> ')}`);
  }

  return new PackageReleaseConsistencyError(lines.join('\n'));
}

export async function assertPackageReleaseConsistency(
  options: AssertPackageReleaseConsistencyOptions,
): Promise<void> {
  const workspacePackages = (
    await collectWorkspacePackages(options.config)
  ).filter(isNamedWorkspacePackage);
  const sourcePackage = workspacePackages.find(
    (workspacePackage) => workspacePackage.name === options.outputManifest.name,
  );
  const state = createReleaseConsistencyState();

  if (sourcePackage) {
    state.visitedPackages.add(sourcePackage.name);
    await visitWorkspacePackageDependencies({
      config: options.config,
      importerName: sourcePackage.name,
      isRoot: true,
      manifest: sourcePackage.manifest,
      state,
      workspacePackagesByName: new Map(
        workspacePackages.map((workspacePackage) => [
          workspacePackage.name,
          workspacePackage,
        ]),
      ),
    });
  }

  const packedPackage = await unpackPackedPackage(options.packedTarball);
  const contentFiles = getPackedContentFiles(packedPackage);

  validateReleaseTarballHygiene({
    contentFiles,
    rootPackageName: options.outputManifest.name,
    state,
  });

  const packedManifest = readPackedPackageJson({
    contentFiles,
    rootPackageName: options.outputManifest.name,
    state,
  });

  if (packedManifest) {
    validatePackedManifestLint({
      config: options.config,
      manifest: packedManifest,
      outDir: options.outDir,
      rootPackageName: options.outputManifest.name,
      state,
    });

    validatePackedManifest({
      manifest: packedManifest,
      rootPackageName: options.outputManifest.name,
      state,
    });
  }

  const error = createReleaseConsistencyError({
    config: options.config,
    label: options.label,
    outDir: options.outDir,
    rootPackageName: options.outputManifest.name,
    state,
  });

  if (error) {
    throw error;
  }
}
