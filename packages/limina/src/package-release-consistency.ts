import { unpack } from '@publint/pack';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { ResolvedLiminaConfig } from './config';
import { formatErrorMessage } from './logger';
import { toRelativePath } from './utils/path';
import {
  collectWorkspacePackages,
  getPublishDependencySections,
  isWorkspaceDependencySpecifier,
  type PackageManifest,
  type PublishDependencySectionName,
  type WorkspacePackage,
} from './workspace';

interface SemverModule {
  satisfies: (
    version: string,
    range: string,
    options?: {
      includePrerelease?: boolean;
    },
  ) => boolean;
  valid: (version: string) => string | null;
}

interface NpmPackageJsonLintIssue {
  lintId: string;
  lintMessage: string;
  node: string;
  severity: string;
}

interface NpmPackageJsonLintResult {
  results: Array<{
    errorCount: number;
    issues: NpmPackageJsonLintIssue[];
  }>;
}

interface NpmPackageJsonLintModule {
  NpmPackageJsonLint: new (options: {
    config: Record<string, unknown>;
    cwd: string;
    packageJsonFilePath: string;
    packageJsonObject: PublishManifest;
  }) => {
    lint: () => NpmPackageJsonLintResult;
  };
}

interface PublishDependencyEntry {
  dependencyName: string;
  sectionName: PublishDependencySectionName;
  specifier: string;
}

interface PublishManifest {
  dependencies?: Record<string, string>;
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

interface RegistryVersionMetadata {
  gitHead?: unknown;
}

interface RegistryPackageMetadata {
  versions?: unknown;
}

interface DirectWorkspaceDependency {
  dependencyName: string;
  sectionName: PublishDependencySectionName;
  targetPackage: WorkspacePackage;
}

interface ReleaseConsistencyProblem {
  dependencyName?: string;
  importerName: string;
  message: string;
  packageName?: string;
  sectionName?: PublishDependencySectionName;
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

const require = createRequire(import.meta.url);
const semver = require('semver') as SemverModule;
const { NpmPackageJsonLint } =
  require('npm-package-json-lint') as NpmPackageJsonLintModule;
const REQUIRED_RELEASE_FILES = ['README.md', 'LICENSE.md'] as const;
const SOURCE_MAPPING_URL_PATTERN =
  /(?:\/\/\s*#\s*sourceMappingURL\s*=|\/\*\s*#\s*sourceMappingURL\s*=)/u;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
  const registryMetadata = isRecord(metadata)
    ? (metadata as RegistryPackageMetadata)
    : null;

  state.registryMetadataCache.set(packageName, registryMetadata);
  return registryMetadata;
}

function findRegistryVersionMetadata(
  metadata: RegistryPackageMetadata,
  version: string,
): RegistryVersionMetadata | null {
  if (!isRecord(metadata.versions)) {
    return null;
  }

  const versionMetadata = metadata.versions[version];

  return isRecord(versionMetadata)
    ? (versionMetadata as RegistryVersionMetadata)
    : null;
}

function execGitCommand(
  config: ResolvedLiminaConfig,
  args: string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', config.rootDir, ...args],
      {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(stdout);
      },
    );
  });
}

async function hasWorkspacePackageChangesSinceGitHead(options: {
  config: ResolvedLiminaConfig;
  gitHead: string;
  workspacePackage: WorkspacePackage;
}): Promise<boolean> {
  const relativeDirectory = toRelativePath(
    options.config.rootDir,
    options.workspacePackage.directory,
  );

  try {
    await execGitCommand(options.config, [
      'diff',
      '--quiet',
      options.gitHead,
      '--',
      relativeDirectory,
    ]);
  } catch (error) {
    if (isRecord(error) && error.code === 1) {
      return true;
    }

    throw error;
  }

  const untrackedOutput = await execGitCommand(options.config, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    relativeDirectory,
  ]);

  return untrackedOutput.trim().length > 0;
}

async function verifyWorkspacePackagePublished(options: {
  config: ResolvedLiminaConfig;
  state: ReleaseConsistencyState;
  workspacePackage: WorkspacePackage;
}): Promise<void> {
  const { state, workspacePackage } = options;
  const version = workspacePackage.manifest.version;

  if (!version || !semver.valid(version)) {
    state.unpublishedPackageNames.add(workspacePackage.name);
    state.registryProblems.push({
      importerName: workspacePackage.name,
      message: [
        'workspace package must declare a valid semver version',
        'before another publishable package can depend on it',
      ].join(' '),
      packageName: workspacePackage.name,
    });
    return;
  }

  let metadata: RegistryPackageMetadata | null;

  try {
    metadata = await fetchRegistryPackageMetadata(workspacePackage.name, state);
  } catch (error) {
    state.unpublishedPackageNames.add(workspacePackage.name);
    state.registryProblems.push({
      importerName: workspacePackage.name,
      message: [
        `unable to read npm registry metadata for ${workspacePackage.name}@${version}:`,
        formatErrorMessage(error),
      ].join(' '),
      packageName: workspacePackage.name,
    });
    return;
  }

  if (!metadata) {
    state.unpublishedPackageNames.add(workspacePackage.name);
    state.registryProblems.push({
      importerName: workspacePackage.name,
      message: `${workspacePackage.name}@${version} is not published to the npm registry`,
      packageName: workspacePackage.name,
    });
    return;
  }

  const versionMetadata = findRegistryVersionMetadata(metadata, version);

  if (!versionMetadata) {
    state.unpublishedPackageNames.add(workspacePackage.name);
    state.registryProblems.push({
      importerName: workspacePackage.name,
      message: `${workspacePackage.name}@${version} is not published to the npm registry`,
      packageName: workspacePackage.name,
    });
    return;
  }

  if (
    typeof versionMetadata.gitHead !== 'string' ||
    versionMetadata.gitHead.trim().length === 0
  ) {
    state.unpublishedPackageNames.add(workspacePackage.name);
    state.registryProblems.push({
      importerName: workspacePackage.name,
      message: [
        `${workspacePackage.name}@${version} registry metadata has no gitHead,`,
        'so limina cannot prove the published source baseline',
      ].join(' '),
      packageName: workspacePackage.name,
    });
    return;
  }

  let hasChanges: boolean;

  try {
    hasChanges = await hasWorkspacePackageChangesSinceGitHead({
      config: options.config,
      gitHead: versionMetadata.gitHead,
      workspacePackage,
    });
  } catch (error) {
    state.unpublishedPackageNames.add(workspacePackage.name);
    state.registryProblems.push({
      importerName: workspacePackage.name,
      message: [
        `unable to compare ${workspacePackage.name}@${version}`,
        `against published gitHead ${versionMetadata.gitHead}:`,
        formatErrorMessage(error),
      ].join(' '),
      packageName: workspacePackage.name,
    });
    return;
  }

  if (hasChanges) {
    state.unpublishedPackageNames.add(workspacePackage.name);
    state.registryProblems.push({
      importerName: workspacePackage.name,
      message: [
        `${workspacePackage.name}@${version} has workspace changes`,
        `after the published npm registry gitHead ${versionMetadata.gitHead}`,
      ].join(' '),
      packageName: workspacePackage.name,
    });
  }
}

async function visitWorkspacePackageDependencies(options: {
  config: ResolvedLiminaConfig;
  importerName: string;
  isRoot: boolean;
  manifest: PackageManifest;
  state: ReleaseConsistencyState;
  workspacePackagesByName: Map<string, WorkspacePackage>;
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
  const workspacePackages = await collectWorkspacePackages(options.config);
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
