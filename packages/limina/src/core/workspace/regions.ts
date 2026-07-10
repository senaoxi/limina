import type { RegionExcludeConfig, ResolvedLiminaConfig } from '#config/runner';
import { readJsonConfig } from '#core/tsconfig/actions';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  normalizeSlashes,
  toPosixPath,
  toRelativePath,
} from '#utils/path';
import { isPlainRecord } from '#utils/values';
import { readFileSync } from 'node:fs';
import path from 'pathe';
import rawPicomatch from 'picomatch';
import { glob } from 'tinyglobby';
import { generatedRootDirName } from '../build-graph/generated/paths';
import type { PackageManifest, WorkspacePackage } from './actions';

interface WorkspaceRegionBoundaryBase {
  excluded: boolean;
  exclusionReason?: string;
  rootDir: string;
}

export interface PackageScopeRegionBoundary
  extends WorkspaceRegionBoundaryBase {
  allowWorkspacePackageReentry?: boolean;
  kind: 'package-scope';
  packageJsonPath: string;
}

export interface PnpmWorkspaceRegionBoundary
  extends WorkspaceRegionBoundaryBase {
  kind: 'pnpm-workspace';
  workspacePackages: WorkspacePackage[];
  workspaceYamlPath: string;
}

export type WorkspaceRegionBoundary =
  | PackageScopeRegionBoundary
  | PnpmWorkspaceRegionBoundary;

export interface ExtendedPackageScope {
  ownerDirectory: string;
  packageJsonPath: string;
  rootDir: string;
}

export interface WorkspaceRegionTopology {
  boundaries: WorkspaceRegionBoundary[];
  extendedPackageScopes: ExtendedPackageScope[];
  packages: WorkspacePackage[];
  rawPackages: WorkspacePackage[];
}

export type WorkspacePackagesProvider = (
  config: ResolvedLiminaConfig,
) => Promise<WorkspacePackage[]>;

interface CompiledRegionExclude {
  entry: RegionExcludeConfig;
  matchers: ((value: string) => boolean)[];
  matchedRoots: Set<string>;
}

interface RegionRootCandidate {
  descriptorPath: string;
  key: string;
  kind:
    | 'extended-package-scope'
    | 'package-scope-boundary'
    | 'pnpm-workspace-boundary'
    | 'workspace-package';
  rootDir: string;
}

const picomatch = rawPicomatch as unknown as (
  pattern: string,
  options?: { dot?: boolean; posixSlashes?: boolean },
) => (value: string) => boolean;

const workspaceRegionDiscoveryIgnore = [
  '**/node_modules/**',
  '**/.git/**',
  `${generatedRootDirName}/**`,
  `**/${generatedRootDirName}/**`,
] as const;

function normalizeExactDirectoryIgnorePattern(pattern: string): string[] {
  const normalized = pattern.replaceAll('\\', '/').replace(/\/+$/u, '');

  return normalized ? [normalized, `${normalized}/**`] : [];
}

function normalizeRegionPattern(pattern: string): string {
  return normalizeSlashes(pattern.trim()).replaceAll(/^\.\//gu, '');
}

function isInsideNodeModulesPath(filePath: string): boolean {
  return normalizeAbsolutePath(filePath).split('/').includes('node_modules');
}

function compileRegionExcludes(
  config: ResolvedLiminaConfig,
): CompiledRegionExclude[] {
  return (config.regions?.exclude ?? []).map((entry) => ({
    entry,
    matchers: entry.include.map((pattern) =>
      picomatch(normalizeRegionPattern(pattern), {
        dot: true,
        posixSlashes: true,
      }),
    ),
    matchedRoots: new Set(),
  }));
}

function collectRegionRootMatchCandidates(options: {
  config: ResolvedLiminaConfig;
  descriptorPath: string;
  rootDir: string;
}): string[] {
  const relativeRoot = normalizeSlashes(
    toRelativePath(options.config.rootDir, options.rootDir),
  );
  const relativeDescriptor = normalizeSlashes(
    toRelativePath(options.config.rootDir, options.descriptorPath),
  );

  return [
    ...new Set([relativeRoot, `${relativeRoot}/`, relativeDescriptor]),
  ].filter((candidate) => candidate.length > 0);
}

function findRegionRootExclusion(options: {
  candidate: RegionRootCandidate;
  config: ResolvedLiminaConfig;
  excludes: CompiledRegionExclude[];
}): RegionExcludeConfig | null {
  const candidates = collectRegionRootMatchCandidates({
    config: options.config,
    descriptorPath: options.candidate.descriptorPath,
    rootDir: options.candidate.rootDir,
  });

  let selectedExclusion: RegionExcludeConfig | null = null;

  for (const exclude of options.excludes) {
    if (
      exclude.matchers.some((matches) =>
        candidates.some((candidate) => matches(candidate)),
      )
    ) {
      exclude.matchedRoots.add(options.candidate.key);
      selectedExclusion ??= exclude.entry;
    }
  }

  return selectedExclusion;
}

function validateRegionExcludes(options: {
  config: ResolvedLiminaConfig;
  excludes: readonly CompiledRegionExclude[];
}): void {
  for (const exclude of options.excludes) {
    if (exclude.matchedRoots.size > 0) {
      continue;
    }

    throw new Error(
      [
        'regions.exclude does not match a recognized governance unit or boundary root.',
        `  include: ${exclude.entry.include.join(', ')}`,
        `  workspace: ${options.config.rootDir}`,
        '  reason: regions.exclude can only crop workspace package roots, extended package scopes, stopped package scopes, or nested pnpm workspace roots.',
      ].join('\n'),
    );
  }
}

function readExplicitOutputOutDir(options: {
  config: ResolvedLiminaConfig;
  sourceConfigPath: string;
}): string | null {
  let configObject: Record<string, unknown>;

  try {
    configObject = readJsonConfig(options.config, options.sourceConfigPath);
  } catch {
    return null;
  }

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

  const resolvedOutDir = normalizeAbsolutePath(
    path.resolve(path.dirname(options.sourceConfigPath), outDir.trim()),
  );

  if (
    resolvedOutDir === normalizeAbsolutePath(options.config.rootDir) ||
    !isPathInsideDirectory(resolvedOutDir, options.config.rootDir)
  ) {
    return null;
  }

  return resolvedOutDir;
}

async function collectConfiguredOutputDirectoryIgnorePatterns(options: {
  config: ResolvedLiminaConfig;
  rawRegionBoundaries: readonly WorkspaceRegionBoundary[];
}): Promise<string[]> {
  const sourceConfigPaths = await glob('**/tsconfig.json', {
    absolute: true,
    cwd: options.config.rootDir,
    ignore: [...workspaceRegionDiscoveryIgnore],
    onlyFiles: true,
  });
  const rawRegionBoundaryIndex = createWorkspaceRegionBoundaryIndex(
    options.rawRegionBoundaries,
  );

  const sourceConfigOutputPatterns = sourceConfigPaths.flatMap(
    (sourceConfigPath) => {
      const normalizedSourceConfigPath =
        normalizeAbsolutePath(sourceConfigPath);

      if (rawRegionBoundaryIndex.isInsideBoundary(normalizedSourceConfigPath)) {
        return [];
      }

      const outDir = readExplicitOutputOutDir({
        config: options.config,
        sourceConfigPath: normalizedSourceConfigPath,
      });

      if (!outDir) {
        return [];
      }

      return normalizeExactDirectoryIgnorePattern(
        toPosixPath(toRelativePath(options.config.rootDir, outDir)),
      );
    },
  );
  const packageOutputPatterns = (options.config.package?.entries ?? []).flatMap(
    (entry) => {
      const resolvedOutDir = normalizeAbsolutePath(
        path.resolve(options.config.rootDir, entry.outDir),
      );

      if (
        resolvedOutDir === normalizeAbsolutePath(options.config.rootDir) ||
        !isPathInsideDirectory(resolvedOutDir, options.config.rootDir)
      ) {
        return [];
      }

      return normalizeExactDirectoryIgnorePattern(
        toPosixPath(toRelativePath(options.config.rootDir, resolvedOutDir)),
      );
    },
  );

  return [
    ...new Set([...sourceConfigOutputPatterns, ...packageOutputPatterns]),
  ];
}

async function collectNestedWorkspaceYamlPaths(
  config: ResolvedLiminaConfig,
): Promise<{ outputIgnorePatterns: string[]; workspaceYamlPaths: string[] }> {
  const currentWorkspaceYamlPath = normalizeAbsolutePath(
    path.join(config.rootDir, 'pnpm-workspace.yaml'),
  );
  const rawWorkspaceYamlPaths = (
    await glob('**/pnpm-workspace.yaml', {
      absolute: true,
      cwd: config.rootDir,
      ignore: [...workspaceRegionDiscoveryIgnore],
      onlyFiles: true,
    })
  )
    .map(normalizeAbsolutePath)
    .filter(
      (workspaceYamlPath) => workspaceYamlPath !== currentWorkspaceYamlPath,
    );
  const rawRegionBoundaries = rawWorkspaceYamlPaths.map(
    (workspaceYamlPath): PnpmWorkspaceRegionBoundary => ({
      excluded: false,
      kind: 'pnpm-workspace',
      rootDir: normalizeAbsolutePath(path.dirname(workspaceYamlPath)),
      workspacePackages: [],
      workspaceYamlPath,
    }),
  );
  const outputIgnorePatterns =
    await collectConfiguredOutputDirectoryIgnorePatterns({
      config,
      rawRegionBoundaries,
    });
  const outputIgnoreMatchers = outputIgnorePatterns.map((pattern) =>
    picomatch(pattern, {
      dot: true,
      posixSlashes: true,
    }),
  );
  const workspaceYamlPaths = rawWorkspaceYamlPaths.filter(
    (workspaceYamlPath) => {
      const relativeWorkspaceYamlPath = normalizeSlashes(
        toRelativePath(config.rootDir, workspaceYamlPath),
      );

      return !outputIgnoreMatchers.some((matches) =>
        matches(relativeWorkspaceYamlPath),
      );
    },
  );

  return {
    outputIgnorePatterns,
    workspaceYamlPaths: workspaceYamlPaths.sort((left, right) =>
      toRelativePath(config.rootDir, left).localeCompare(
        toRelativePath(config.rootDir, right),
      ),
    ),
  };
}

function createNestedWorkspaceConfig(options: {
  config: ResolvedLiminaConfig;
  rootDir: string;
}): ResolvedLiminaConfig {
  return {
    ...options.config,
    configPath: path.join(options.rootDir, 'limina.config.mjs'),
    regions: undefined,
    rootDir: options.rootDir,
  };
}

async function collectPnpmWorkspaceBoundaries(options: {
  config: ResolvedLiminaConfig;
  provider: WorkspacePackagesProvider;
  workspaceYamlPaths: readonly string[];
}): Promise<PnpmWorkspaceRegionBoundary[]> {
  return Promise.all(
    options.workspaceYamlPaths.map(async (workspaceYamlPath) => {
      const rootDir = normalizeAbsolutePath(path.dirname(workspaceYamlPath));
      let workspacePackages: WorkspacePackage[];

      try {
        workspacePackages = await options.provider(
          createNestedWorkspaceConfig({
            config: options.config,
            rootDir,
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        throw new Error(
          [
            'Failed to inspect nested pnpm workspace region.',
            `  nested workspace: ${toRelativePath(options.config.rootDir, rootDir)}`,
            `  nested workspace config: ${toRelativePath(options.config.rootDir, workspaceYamlPath)}`,
            `  error: ${message}`,
          ].join('\n'),
          { cause: error },
        );
      }

      return {
        excluded: false,
        kind: 'pnpm-workspace',
        rootDir,
        workspacePackages,
        workspaceYamlPath,
      } satisfies PnpmWorkspaceRegionBoundary;
    }),
  );
}

function collectWorkspaceClaimDirectories(options: {
  nestedBoundaries: readonly PnpmWorkspaceRegionBoundary[];
  rawPackages: readonly WorkspacePackage[];
}): Set<string> {
  return new Set(
    [
      ...options.rawPackages,
      ...options.nestedBoundaries.flatMap(
        (boundary) => boundary.workspacePackages,
      ),
    ].map((workspacePackage) =>
      normalizeAbsolutePath(workspacePackage.directory),
    ),
  );
}

function findNearestWorkspacePackage(
  directory: string,
  packages: readonly WorkspacePackage[],
): WorkspacePackage | null {
  return (
    packages.find((workspacePackage) =>
      isPathInsideDirectory(directory, workspacePackage.directory),
    ) ?? null
  );
}

function readPackageManifest(packageJsonPath: string): PackageManifest {
  return JSON.parse(
    readFileSync(packageJsonPath, 'utf8').replace(/^\uFEFF/u, ''),
  ) as PackageManifest;
}

async function collectPackageScopeTopology(options: {
  activeBasePackages: readonly WorkspacePackage[];
  config: ResolvedLiminaConfig;
  nestedWorkspaceBoundaries: readonly PnpmWorkspaceRegionBoundary[];
  outputIgnorePatterns: readonly string[];
  workspaceClaimDirectories: ReadonlySet<string>;
}): Promise<{
  boundaries: PackageScopeRegionBoundary[];
  extendedPackageScopes: ExtendedPackageScope[];
}> {
  const packageJsonPaths = (
    await glob('**/package.json', {
      absolute: true,
      cwd: options.config.rootDir,
      ignore: [
        ...workspaceRegionDiscoveryIgnore,
        ...options.outputIgnorePatterns,
      ],
      onlyFiles: true,
    })
  ).map(normalizeAbsolutePath);
  const activeBasePackages = [...options.activeBasePackages].sort(
    (left, right) =>
      normalizeAbsolutePath(right.directory).length -
      normalizeAbsolutePath(left.directory).length,
  );
  const activeBaseDirectories = new Set(
    activeBasePackages.map((workspacePackage) =>
      normalizeAbsolutePath(workspacePackage.directory),
    ),
  );
  const hardBoundaryIndex = createWorkspaceRegionBoundaryIndex(
    options.nestedWorkspaceBoundaries,
  );
  const boundaries: PackageScopeRegionBoundary[] = [];
  const extendedPackageScopes: ExtendedPackageScope[] = [];

  for (const packageJsonPath of packageJsonPaths.sort(
    (left, right) =>
      path.dirname(left).length - path.dirname(right).length ||
      left.localeCompare(right),
  )) {
    const rootDir = normalizeAbsolutePath(path.dirname(packageJsonPath));

    if (activeBaseDirectories.has(rootDir)) {
      continue;
    }

    const owner = findNearestWorkspacePackage(rootDir, activeBasePackages);

    if (!owner || hardBoundaryIndex.isInsideBoundary(rootDir)) {
      continue;
    }

    const ownerDirectory = normalizeAbsolutePath(owner.directory);
    const stoppedByPackageScope = boundaries.some(
      (boundary) =>
        isPathInsideDirectory(boundary.rootDir, ownerDirectory) &&
        isPathInsideDirectory(rootDir, boundary.rootDir),
    );

    if (stoppedByPackageScope) {
      continue;
    }

    const manifest = readPackageManifest(packageJsonPath);
    const isExpandable =
      options.config.regions?.extendNestedPackageScopes === true &&
      !Object.hasOwn(manifest, 'name') &&
      !options.workspaceClaimDirectories.has(rootDir);

    if (isExpandable) {
      extendedPackageScopes.push({
        ownerDirectory,
        packageJsonPath,
        rootDir,
      });
      continue;
    }

    boundaries.push({
      excluded: false,
      kind: 'package-scope',
      packageJsonPath,
      rootDir,
    });
  }

  return {
    boundaries,
    extendedPackageScopes,
  };
}

function createRegionRootCandidate(options: {
  descriptorPath: string;
  kind: RegionRootCandidate['kind'];
  rootDir: string;
}): RegionRootCandidate {
  return {
    ...options,
    key: `${options.kind}\0${normalizeAbsolutePath(options.rootDir)}`,
  };
}

function applyRegionExcludes(options: {
  activeBasePackages: readonly WorkspacePackage[];
  config: ResolvedLiminaConfig;
  extendedPackageScopes: readonly ExtendedPackageScope[];
  packageScopeBoundaries: readonly PackageScopeRegionBoundary[];
  pnpmWorkspaceBoundaries: readonly PnpmWorkspaceRegionBoundary[];
}): {
  boundaries: WorkspaceRegionBoundary[];
  packages: WorkspacePackage[];
} {
  const excludes = compileRegionExcludes(options.config);
  const packageCandidates = options.activeBasePackages.map((workspacePackage) =>
    createRegionRootCandidate({
      descriptorPath: path.join(workspacePackage.directory, 'package.json'),
      kind: 'workspace-package',
      rootDir: workspacePackage.directory,
    }),
  );
  const extendedCandidates = options.extendedPackageScopes.map((scope) =>
    createRegionRootCandidate({
      descriptorPath: scope.packageJsonPath,
      kind: 'extended-package-scope',
      rootDir: scope.rootDir,
    }),
  );
  const packageBoundaryCandidates = options.packageScopeBoundaries.map(
    (boundary) =>
      createRegionRootCandidate({
        descriptorPath: boundary.packageJsonPath,
        kind: 'package-scope-boundary',
        rootDir: boundary.rootDir,
      }),
  );
  const workspaceBoundaryCandidates = options.pnpmWorkspaceBoundaries.map(
    (boundary) =>
      createRegionRootCandidate({
        descriptorPath: boundary.workspaceYamlPath,
        kind: 'pnpm-workspace-boundary',
        rootDir: boundary.rootDir,
      }),
  );
  const exclusionsByCandidateKey = new Map<string, RegionExcludeConfig>();

  for (const candidate of [
    ...packageCandidates,
    ...extendedCandidates,
    ...packageBoundaryCandidates,
    ...workspaceBoundaryCandidates,
  ]) {
    const exclusion = findRegionRootExclusion({
      candidate,
      config: options.config,
      excludes,
    });

    if (exclusion) {
      exclusionsByCandidateKey.set(candidate.key, exclusion);
    }
  }

  validateRegionExcludes({ config: options.config, excludes });

  let boundaries: WorkspaceRegionBoundary[] = [
    ...options.pnpmWorkspaceBoundaries.map((boundary, index) => {
      const exclusion = exclusionsByCandidateKey.get(
        workspaceBoundaryCandidates[index]?.key ?? '',
      );

      return {
        ...boundary,
        excluded: Boolean(exclusion),
        ...(exclusion ? { exclusionReason: exclusion.reason.trim() } : {}),
      };
    }),
    ...options.packageScopeBoundaries.map((boundary, index) => {
      const exclusion = exclusionsByCandidateKey.get(
        packageBoundaryCandidates[index]?.key ?? '',
      );

      return {
        ...boundary,
        excluded: Boolean(exclusion),
        ...(exclusion
          ? {
              allowWorkspacePackageReentry: true,
              exclusionReason: exclusion.reason.trim(),
            }
          : {}),
      };
    }),
  ];

  for (const [index, scope] of options.extendedPackageScopes.entries()) {
    const exclusion = exclusionsByCandidateKey.get(
      extendedCandidates[index]?.key ?? '',
    );

    if (!exclusion) {
      continue;
    }

    boundaries.push({
      excluded: true,
      exclusionReason: exclusion.reason.trim(),
      kind: 'package-scope',
      packageJsonPath: scope.packageJsonPath,
      rootDir: scope.rootDir,
    });
  }

  for (const [
    index,
    workspacePackage,
  ] of options.activeBasePackages.entries()) {
    const exclusion = exclusionsByCandidateKey.get(
      packageCandidates[index]?.key ?? '',
    );

    if (!exclusion) {
      continue;
    }

    boundaries.push({
      allowWorkspacePackageReentry:
        normalizeAbsolutePath(workspacePackage.directory) ===
        normalizeAbsolutePath(options.config.rootDir),
      excluded: true,
      exclusionReason: exclusion.reason.trim(),
      kind: 'package-scope',
      packageJsonPath: normalizeAbsolutePath(
        path.join(workspacePackage.directory, 'package.json'),
      ),
      rootDir: normalizeAbsolutePath(workspacePackage.directory),
    });
  }

  const configRootDir = normalizeAbsolutePath(options.config.rootDir);
  const activeBasePackages = [...options.activeBasePackages].sort(
    (left, right) =>
      normalizeAbsolutePath(right.directory).length -
      normalizeAbsolutePath(left.directory).length,
  );
  const directlyExcludedBoundaries = boundaries
    .filter((boundary) => boundary.excluded)
    .sort(
      (left, right) =>
        normalizeAbsolutePath(right.rootDir).length -
        normalizeAbsolutePath(left.rootDir).length,
    );

  boundaries = boundaries.map((boundary) => {
    if (boundary.excluded) {
      return boundary;
    }

    const excludedAncestor = directlyExcludedBoundaries.find((candidate) => {
      if (
        normalizeAbsolutePath(candidate.rootDir) ===
          normalizeAbsolutePath(boundary.rootDir) ||
        !isPathInsideDirectory(boundary.rootDir, candidate.rootDir)
      ) {
        return false;
      }

      if (
        candidate.kind !== 'package-scope' ||
        !candidate.allowWorkspacePackageReentry
      ) {
        return true;
      }

      const ancestorBasePackage = findNearestWorkspacePackage(
        candidate.rootDir,
        activeBasePackages,
      );
      const boundaryBasePackage = findNearestWorkspacePackage(
        boundary.rootDir,
        activeBasePackages,
      );

      return (
        ancestorBasePackage !== null &&
        boundaryBasePackage !== null &&
        normalizeAbsolutePath(ancestorBasePackage.directory) ===
          normalizeAbsolutePath(boundaryBasePackage.directory)
      );
    });

    if (!excludedAncestor) {
      return boundary;
    }

    return {
      ...boundary,
      excluded: true,
      ...(boundary.kind === 'package-scope' &&
      excludedAncestor.kind === 'package-scope' &&
      excludedAncestor.allowWorkspacePackageReentry
        ? { allowWorkspacePackageReentry: true }
        : {}),
      ...(excludedAncestor.exclusionReason
        ? { exclusionReason: excludedAncestor.exclusionReason }
        : {}),
    };
  });

  const boundaryIndex = createWorkspaceRegionBoundaryIndex(boundaries);
  const excludedPackageRoots = options.activeBasePackages.flatMap(
    (workspacePackage, index) =>
      exclusionsByCandidateKey.has(packageCandidates[index]?.key ?? '')
        ? [normalizeAbsolutePath(workspacePackage.directory)]
        : [],
  );
  const packages = options.activeBasePackages.filter((workspacePackage) => {
    const packageDirectory = normalizeAbsolutePath(workspacePackage.directory);

    if (boundaryIndex.isInsideHardBoundary(packageDirectory)) {
      return false;
    }

    return !excludedPackageRoots.some((excludedRoot) => {
      if (packageDirectory === excludedRoot) {
        return true;
      }

      return (
        excludedRoot !== configRootDir &&
        isPathInsideDirectory(packageDirectory, excludedRoot)
      );
    });
  });

  return {
    boundaries: boundaries.sort((left, right) =>
      toRelativePath(options.config.rootDir, left.rootDir).localeCompare(
        toRelativePath(options.config.rootDir, right.rootDir),
      ),
    ),
    packages,
  };
}

export async function collectWorkspaceRegionTopology(
  config: ResolvedLiminaConfig,
  options: {
    provider: WorkspacePackagesProvider;
    rawPackages?: readonly WorkspacePackage[];
  },
): Promise<WorkspaceRegionTopology> {
  const rawPackages = options.rawPackages
    ? [...options.rawPackages]
    : await options.provider(config);
  const { outputIgnorePatterns, workspaceYamlPaths } =
    await collectNestedWorkspaceYamlPaths(config);
  const pnpmWorkspaceBoundaries = await collectPnpmWorkspaceBoundaries({
    config,
    provider: options.provider,
    workspaceYamlPaths,
  });
  const hardBoundaryIndex = createWorkspaceRegionBoundaryIndex(
    pnpmWorkspaceBoundaries,
  );
  const activeBasePackages = rawPackages.filter(
    (workspacePackage) =>
      !hardBoundaryIndex.isInsideHardBoundary(workspacePackage.directory),
  );
  const workspaceClaimDirectories = collectWorkspaceClaimDirectories({
    nestedBoundaries: pnpmWorkspaceBoundaries,
    rawPackages,
  });
  const packageScopeTopology = await collectPackageScopeTopology({
    activeBasePackages,
    config,
    nestedWorkspaceBoundaries: pnpmWorkspaceBoundaries,
    outputIgnorePatterns,
    workspaceClaimDirectories,
  });
  const excludedTopology = applyRegionExcludes({
    activeBasePackages,
    config,
    extendedPackageScopes: packageScopeTopology.extendedPackageScopes,
    packageScopeBoundaries: packageScopeTopology.boundaries,
    pnpmWorkspaceBoundaries,
  });

  return {
    boundaries: excludedTopology.boundaries,
    extendedPackageScopes: packageScopeTopology.extendedPackageScopes,
    packages: excludedTopology.packages,
    rawPackages,
  };
}

export async function collectWorkspaceRegionBoundaries(
  config: ResolvedLiminaConfig,
  provider: WorkspacePackagesProvider,
): Promise<WorkspaceRegionBoundary[]> {
  return (await collectWorkspaceRegionTopology(config, { provider }))
    .boundaries;
}

export class WorkspaceRegionBoundaryIndex {
  readonly boundaries: WorkspaceRegionBoundary[];
  readonly #packages: WorkspacePackage[];

  constructor(
    boundaries: readonly WorkspaceRegionBoundary[],
    packages: readonly WorkspacePackage[] = [],
  ) {
    this.boundaries = [...boundaries].sort(
      (left, right) =>
        normalizeAbsolutePath(right.rootDir).length -
        normalizeAbsolutePath(left.rootDir).length,
    );
    this.#packages = [...packages].sort(
      (left, right) =>
        normalizeAbsolutePath(right.directory).length -
        normalizeAbsolutePath(left.directory).length,
    );
  }

  findBoundaryForPath(filePath: string): WorkspaceRegionBoundary | null {
    const normalizedFilePath = normalizeAbsolutePath(filePath);
    const hardBoundary = this.boundaries.find(
      (boundary) =>
        this.#isHardBoundary(boundary) &&
        isPathInsideDirectory(normalizedFilePath, boundary.rootDir),
    );

    if (hardBoundary) {
      return hardBoundary;
    }

    const packageScopeBoundary = this.boundaries.find(
      (boundary) =>
        boundary.kind === 'package-scope' &&
        isPathInsideDirectory(normalizedFilePath, boundary.rootDir),
    );

    if (!packageScopeBoundary) {
      return null;
    }

    const activePackage = this.#packages.find((workspacePackage) =>
      isPathInsideDirectory(normalizedFilePath, workspacePackage.directory),
    );

    if (
      activePackage &&
      normalizeAbsolutePath(activePackage.directory).length >
        normalizeAbsolutePath(packageScopeBoundary.rootDir).length &&
      isPathInsideDirectory(
        activePackage.directory,
        packageScopeBoundary.rootDir,
      )
    ) {
      return null;
    }

    return packageScopeBoundary;
  }

  isInsideBoundary(filePath: string): boolean {
    return Boolean(this.findBoundaryForPath(filePath));
  }

  isInsideHardBoundary(filePath: string): boolean {
    const normalizedFilePath = normalizeAbsolutePath(filePath);

    return this.boundaries.some(
      (boundary) =>
        this.#isHardBoundary(boundary) &&
        isPathInsideDirectory(normalizedFilePath, boundary.rootDir),
    );
  }

  #isHardBoundary(boundary: WorkspaceRegionBoundary): boolean {
    return (
      boundary.kind === 'pnpm-workspace' ||
      (boundary.excluded && !boundary.allowWorkspacePackageReentry)
    );
  }
}

export function createWorkspaceRegionBoundaryIndex(
  boundaries: readonly WorkspaceRegionBoundary[],
  packages: readonly WorkspacePackage[] = [],
): WorkspaceRegionBoundaryIndex {
  return new WorkspaceRegionBoundaryIndex(boundaries, packages);
}

export function createWorkspaceRegionBoundaryIgnorePatterns(
  config: ResolvedLiminaConfig,
  boundaries: readonly WorkspaceRegionBoundary[],
  packages: readonly WorkspacePackage[] = [],
): string[] {
  return boundaries.flatMap((boundary) => {
    const hasActivatedPackageDescendant =
      boundary.kind === 'package-scope' &&
      (!boundary.excluded || boundary.allowWorkspacePackageReentry) &&
      packages.some(
        (workspacePackage) =>
          normalizeAbsolutePath(workspacePackage.directory) !==
            normalizeAbsolutePath(boundary.rootDir) &&
          isPathInsideDirectory(workspacePackage.directory, boundary.rootDir),
      );

    if (hasActivatedPackageDescendant) {
      return [];
    }

    const relativeRoot = normalizeSlashes(
      toRelativePath(config.rootDir, boundary.rootDir),
    );

    return relativeRoot === '.' ? [] : [relativeRoot, `${relativeRoot}/**`];
  });
}

export function filterCurrentRegionWorkspacePackages(options: {
  packages: readonly WorkspacePackage[];
  regionBoundaries: readonly WorkspaceRegionBoundary[];
}): WorkspacePackage[] {
  const boundaryIndex = createWorkspaceRegionBoundaryIndex(
    options.regionBoundaries,
  );

  return options.packages.filter(
    (workspacePackage) =>
      !boundaryIndex.isInsideHardBoundary(workspacePackage.directory),
  );
}

export class WorkspaceActivatedRegionIndex {
  readonly packages: WorkspacePackage[];
  readonly rootDir: string;
  readonly #boundaries: WorkspaceRegionBoundaryIndex;

  constructor(options: {
    boundaries?: readonly WorkspaceRegionBoundary[];
    packages: readonly WorkspacePackage[];
    rootDir: string;
  }) {
    this.rootDir = normalizeAbsolutePath(options.rootDir);
    this.packages = [...options.packages]
      .map((workspacePackage) => ({
        ...workspacePackage,
        directory: normalizeAbsolutePath(workspacePackage.directory),
      }))
      .sort(
        (left, right) =>
          normalizeAbsolutePath(right.directory).length -
          normalizeAbsolutePath(left.directory).length,
      );
    this.#boundaries = createWorkspaceRegionBoundaryIndex(
      options.boundaries ?? [],
      this.packages,
    );
  }

  findPackageForPath(filePath: string): WorkspacePackage | null {
    const normalizedFilePath = normalizeAbsolutePath(filePath);

    if (this.#boundaries.isInsideBoundary(normalizedFilePath)) {
      return null;
    }

    return (
      this.packages.find((workspacePackage) =>
        isPathInsideDirectory(normalizedFilePath, workspacePackage.directory),
      ) ?? null
    );
  }

  isInsideActivatedRegion(filePath: string): boolean {
    return Boolean(this.findPackageForPath(filePath));
  }

  isRootActivated(): boolean {
    return this.packages.some(
      (workspacePackage) =>
        normalizeAbsolutePath(workspacePackage.directory) === this.rootDir,
    );
  }
}

export function createWorkspaceActivatedRegionIndex(options: {
  boundaries?: readonly WorkspaceRegionBoundary[];
  packages: readonly WorkspacePackage[];
  rootDir: string;
}): WorkspaceActivatedRegionIndex {
  return new WorkspaceActivatedRegionIndex(options);
}

export function findContainingWorkspacePackage(options: {
  boundaryRootDir: string;
  packages: readonly WorkspacePackage[];
  rootDir: string;
}): WorkspacePackage | null {
  const rootDir = normalizeAbsolutePath(options.rootDir);

  return (
    options.packages
      .filter((workspacePackage) => {
        const packageDir = normalizeAbsolutePath(workspacePackage.directory);

        return (
          packageDir !== rootDir &&
          isPathInsideDirectory(options.boundaryRootDir, packageDir)
        );
      })
      .sort(
        (left, right) =>
          normalizeAbsolutePath(right.directory).length -
          normalizeAbsolutePath(left.directory).length,
      )[0] ?? null
  );
}

export function isVisibleCurrentRegionSourcePath(options: {
  boundaries: readonly WorkspaceRegionBoundary[];
  filePath: string;
  packages: readonly WorkspacePackage[];
  rootDir: string;
}): boolean {
  const filePath = normalizeAbsolutePath(options.filePath);

  if (isInsideNodeModulesPath(filePath)) {
    return false;
  }

  return createWorkspaceActivatedRegionIndex({
    boundaries: options.boundaries,
    packages: options.packages,
    rootDir: options.rootDir,
  }).isInsideActivatedRegion(filePath);
}
