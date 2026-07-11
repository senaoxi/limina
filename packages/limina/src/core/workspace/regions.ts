import type {
  RegionExcludeConfig,
  RegionExcludeKind,
  ResolvedLiminaConfig,
} from '#config/runner';
import { readJsonConfig } from '#core/tsconfig/actions';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  normalizeSlashes,
  toPosixPath,
  toRelativePath,
} from '#utils/path';
import { isPlainRecord } from '#utils/values';
import { readWorkspaceManifest } from '@pnpm/workspace.read-manifest';
import { readFileSync } from 'node:fs';
import { types as utilTypes } from 'node:util';
import path from 'pathe';
import rawPicomatch from 'picomatch';
import { glob } from 'tinyglobby';
import { generatedRootDirName } from '../build-graph/generated/paths';
import type { PackageManifest, WorkspacePackage } from './actions';

interface WorkspaceRegionBoundaryBase {
  rootDir: string;
}

interface ExcludableWorkspaceRegionBoundaryBase
  extends WorkspaceRegionBoundaryBase {
  excluded: boolean;
  exclusionReason?: string;
}

export interface PackageScopeRegionBoundary
  extends ExcludableWorkspaceRegionBoundaryBase {
  allowWorkspacePackageReentry?: boolean;
  kind: 'package-scope';
  packageJsonPath: string;
}

export type PnpmWorkspaceInspection =
  | {
      status: 'completed';
      workspacePackages: WorkspacePackage[];
    }
  | {
      reason: string;
      status: 'excluded';
    };

export interface PnpmWorkspaceRegionBoundary
  extends WorkspaceRegionBoundaryBase {
  inspection: PnpmWorkspaceInspection;
  kind: 'pnpm-workspace';
  workspaceYamlPath: string;
}

export type WorkspaceRegionBoundary =
  | PackageScopeRegionBoundary
  | PnpmWorkspaceRegionBoundary;

export function getWorkspaceRegionBoundaryExclusionReason(
  boundary: WorkspaceRegionBoundary,
): string | null {
  if (boundary.kind === 'pnpm-workspace') {
    return boundary.inspection.status === 'excluded'
      ? boundary.inspection.reason
      : null;
  }

  return boundary.excluded ? (boundary.exclusionReason ?? null) : null;
}

export function isWorkspaceRegionBoundaryExcluded(
  boundary: WorkspaceRegionBoundary,
): boolean {
  return boundary.kind === 'pnpm-workspace'
    ? boundary.inspection.status === 'excluded'
    : boundary.excluded;
}

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

interface CompiledRegionExcludeRule {
  include: string[];
  index: number;
  kind: RegionExcludeKind;
  matchers: ((value: string) => boolean)[];
  matchedCandidateKeys: Set<string>;
  reason: string;
}

interface RegionRootCandidate {
  descriptorPath: string;
  key: string;
  kind: RegionExcludeKind;
  rootDir: string;
}

interface ResolvedRegionExclusion {
  candidateKey: string;
  reason: string;
  ruleIndex: number;
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

function compileRegionExclusionRules(
  entries: readonly RegionExcludeConfig[] | undefined,
): CompiledRegionExcludeRule[] {
  return (entries ?? []).map((entry, index) => ({
    include: [...entry.include],
    index,
    kind: entry.kind,
    matchers: entry.include.map((pattern) =>
      picomatch(normalizeRegionPattern(pattern), {
        dot: true,
        posixSlashes: true,
      }),
    ),
    matchedCandidateKeys: new Set(),
    reason: entry.reason.trim(),
  }));
}

function createRegionCandidateKey(
  kind: RegionExcludeKind,
  rootDir: string,
): string {
  return `${kind}:${normalizeAbsolutePath(rootDir)}`;
}

function resolveCandidateExclusion(options: {
  candidate: RegionRootCandidate;
  config: ResolvedLiminaConfig;
  rules: CompiledRegionExcludeRule[];
}): ResolvedRegionExclusion | null {
  const relativeRoot = normalizeSlashes(
    toRelativePath(options.config.rootDir, options.candidate.rootDir),
  );
  const matchingRules = options.rules.filter(
    (rule) =>
      rule.kind === options.candidate.kind &&
      rule.matchers.some((matches) => matches(relativeRoot)),
  );

  if (matchingRules.length > 1) {
    throw new Error(
      [
        'Multiple regions.exclude rules match the same governance root.',
        `  kind: ${options.candidate.kind}`,
        `  root: ${relativeRoot}`,
        `  rule 1: regions.exclude[${matchingRules[0]?.index}]`,
        `  rule 2: regions.exclude[${matchingRules[1]?.index}]`,
        '  fix: Make exclusion patterns non-overlapping.',
      ].join('\n'),
    );
  }

  const rule = matchingRules[0];

  if (!rule) {
    return null;
  }

  rule.matchedCandidateKeys.add(options.candidate.key);

  return {
    candidateKey: options.candidate.key,
    reason: rule.reason,
    ruleIndex: rule.index,
  };
}

function validateRootPnpmWorkspaceExclusion(options: {
  config: ResolvedLiminaConfig;
  rules: readonly CompiledRegionExcludeRule[];
}): void {
  const rule = options.rules.find(
    (candidate) =>
      candidate.kind === 'pnpm-workspace' &&
      candidate.matchers.some((matches) => matches('.')),
  );

  if (!rule) {
    return;
  }

  throw new Error(
    [
      'regions.exclude cannot exclude the root pnpm workspace.',
      `  rule: regions.exclude[${rule.index}]`,
      '  root: .',
      '  reason: the root pnpm-workspace.yaml defines the current governance origin.',
    ].join('\n'),
  );
}

function validateRegionExclusionRules(options: {
  config: ResolvedLiminaConfig;
  rules: readonly CompiledRegionExcludeRule[];
}): void {
  for (const rule of options.rules) {
    if (rule.matchedCandidateKeys.size > 0) {
      continue;
    }

    throw new Error(
      [
        'regions.exclude rule does not match a recognized governance root.',
        `  rule: regions.exclude[${rule.index}]`,
        `  kind: ${rule.kind}`,
        `  include: ${rule.include.join(', ')}`,
        `  workspace: ${options.config.rootDir}`,
        `  fix: Match the root directory of a ${rule.kind} governance root.`,
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
  rawBoundaryRoots: readonly string[];
}): Promise<string[]> {
  const sourceConfigPaths = await glob('**/tsconfig.json', {
    absolute: true,
    cwd: options.config.rootDir,
    ignore: [...workspaceRegionDiscoveryIgnore],
    onlyFiles: true,
  });
  const sourceConfigOutputPatterns = sourceConfigPaths.flatMap(
    (sourceConfigPath) => {
      const normalizedSourceConfigPath =
        normalizeAbsolutePath(sourceConfigPath);

      if (
        options.rawBoundaryRoots.some((rootDir) =>
          isPathInsideDirectory(normalizedSourceConfigPath, rootDir),
        )
      ) {
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
  const discoveredWorkspaceYamlPaths = (
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
  const outputIgnorePatterns =
    await collectConfiguredOutputDirectoryIgnorePatterns({
      config,
      rawBoundaryRoots: discoveredWorkspaceYamlPaths.map((workspaceYamlPath) =>
        normalizeAbsolutePath(path.dirname(workspaceYamlPath)),
      ),
    });
  const outputIgnoreMatchers = outputIgnorePatterns.map((pattern) =>
    picomatch(pattern, {
      dot: true,
      posixSlashes: true,
    }),
  );
  const workspaceYamlPaths = discoveredWorkspaceYamlPaths.filter(
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
  rules: CompiledRegionExcludeRule[];
  workspaceYamlPaths: readonly string[];
}): Promise<PnpmWorkspaceRegionBoundary[]> {
  const boundaries: PnpmWorkspaceRegionBoundary[] = [];
  const excludedRoots: { reason: string; rootDir: string }[] = [];
  const workspaceYamlPaths = [...options.workspaceYamlPaths].sort(
    (left, right) =>
      normalizeAbsolutePath(path.dirname(left)).length -
        normalizeAbsolutePath(path.dirname(right)).length ||
      left.localeCompare(right),
  );

  for (const workspaceYamlPath of workspaceYamlPaths) {
    const rootDir = normalizeAbsolutePath(path.dirname(workspaceYamlPath));
    const excludedAncestor = excludedRoots.find((excludedRoot) =>
      isPathInsideDirectory(rootDir, excludedRoot.rootDir),
    );
    const candidate = createRegionRootCandidate({
      descriptorPath: workspaceYamlPath,
      kind: 'pnpm-workspace',
      rootDir,
    });
    const exclusion = resolveCandidateExclusion({
      candidate,
      config: options.config,
      rules: options.rules,
    });

    if (exclusion || excludedAncestor) {
      const reason = exclusion?.reason ?? excludedAncestor?.reason;

      if (!reason) {
        throw new Error('Expected an exclusion reason for nested workspace.');
      }

      if (exclusion) {
        excludedRoots.push({ reason, rootDir });
      }

      boundaries.push({
        inspection: {
          reason,
          status: 'excluded',
        },
        kind: 'pnpm-workspace',
        rootDir,
        workspaceYamlPath,
      });
      continue;
    }

    try {
      await readWorkspaceManifest(rootDir);
    } catch (error) {
      throw createNestedWorkspaceInspectionError({
        config: options.config,
        error,
        phase: 'manifest-validation',
        rootDir,
        workspaceYamlPath,
      });
    }

    let workspacePackages: WorkspacePackage[];

    try {
      workspacePackages = await options.provider(
        createNestedWorkspaceConfig({
          config: options.config,
          rootDir,
        }),
      );
    } catch (error) {
      throw createNestedWorkspaceInspectionError({
        config: options.config,
        error,
        phase: 'package-discovery',
        rootDir,
        workspaceYamlPath,
      });
    }

    boundaries.push({
      inspection: {
        status: 'completed',
        workspacePackages,
      },
      kind: 'pnpm-workspace',
      rootDir,
      workspaceYamlPath,
    });
  }

  return boundaries;
}

function createNestedWorkspaceInspectionError(options: {
  config: ResolvedLiminaConfig;
  error: unknown;
  phase: 'manifest-validation' | 'package-discovery';
  rootDir: string;
  workspaceYamlPath: string;
}): Error {
  const message =
    options.error instanceof Error
      ? options.error.message
      : String(options.error);

  return new Error(
    [
      'Failed to inspect nested pnpm workspace region.',
      `  nested workspace: ${toRelativePath(options.config.rootDir, options.rootDir)}`,
      `  manifest: ${toRelativePath(options.config.rootDir, options.workspaceYamlPath)}`,
      `  phase: ${options.phase}`,
      `  error: ${message}`,
      '  fix: Repair the nested workspace, or add an explicit regions.exclude rule with kind "pnpm-workspace".',
    ].join('\n'),
    { cause: options.error },
  );
}

function collectWorkspaceClaimDirectories(options: {
  nestedBoundaries: readonly PnpmWorkspaceRegionBoundary[];
  rawPackages: readonly WorkspacePackage[];
}): Set<string> {
  return new Set(
    [
      ...options.rawPackages,
      ...options.nestedBoundaries.flatMap((boundary) =>
        boundary.inspection.status === 'completed'
          ? boundary.inspection.workspacePackages
          : [],
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

function readPackageManifest(packageJsonPath: string): PackageManifest | null {
  try {
    return JSON.parse(
      readFileSync(packageJsonPath, 'utf8').replace(/^\uFEFF/u, ''),
    ) as PackageManifest;
  } catch (error) {
    if (utilTypes.isNativeError(error) && error.name === 'SyntaxError') {
      return null;
    }

    throw error;
  }
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

    if (!manifest) {
      continue;
    }

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
    key: createRegionCandidateKey(options.kind, options.rootDir),
  };
}

function applyPackageRegionExclusions(options: {
  config: ResolvedLiminaConfig;
  extendedPackageScopes: readonly ExtendedPackageScope[];
  packageScopeBoundaries: readonly PackageScopeRegionBoundary[];
  pnpmWorkspaceBoundaries: readonly PnpmWorkspaceRegionBoundary[];
  rules: CompiledRegionExcludeRule[];
  workspacePackages: readonly WorkspacePackage[];
}): {
  boundaries: WorkspaceRegionBoundary[];
  extendedPackageScopes: ExtendedPackageScope[];
  packages: WorkspacePackage[];
} {
  const packageCandidates = options.workspacePackages.map((workspacePackage) =>
    createRegionRootCandidate({
      descriptorPath: path.join(workspacePackage.directory, 'package.json'),
      kind: 'workspace-package',
      rootDir: workspacePackage.directory,
    }),
  );
  const extendedCandidates = options.extendedPackageScopes.map((scope) =>
    createRegionRootCandidate({
      descriptorPath: scope.packageJsonPath,
      kind: 'package-scope',
      rootDir: scope.rootDir,
    }),
  );
  const packageBoundaryCandidates = options.packageScopeBoundaries.map(
    (boundary) =>
      createRegionRootCandidate({
        descriptorPath: boundary.packageJsonPath,
        kind: 'package-scope',
        rootDir: boundary.rootDir,
      }),
  );
  const exclusionsByCandidateKey = new Map<string, ResolvedRegionExclusion>();

  for (const candidate of [
    ...packageCandidates,
    ...extendedCandidates,
    ...packageBoundaryCandidates,
  ]) {
    const exclusion = resolveCandidateExclusion({
      candidate,
      config: options.config,
      rules: options.rules,
    });

    if (exclusion) {
      exclusionsByCandidateKey.set(candidate.key, exclusion);
    }
  }

  const boundaries: WorkspaceRegionBoundary[] = [
    ...options.pnpmWorkspaceBoundaries,
    ...options.packageScopeBoundaries.map((boundary, index) => {
      const exclusion = exclusionsByCandidateKey.get(
        packageBoundaryCandidates[index]?.key ?? '',
      );

      return {
        ...boundary,
        excluded: Boolean(exclusion),
        ...(exclusion
          ? {
              exclusionReason: exclusion.reason,
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
      exclusionReason: exclusion.reason,
      kind: 'package-scope',
      packageJsonPath: scope.packageJsonPath,
      rootDir: scope.rootDir,
    });
  }

  for (const [index, workspacePackage] of options.workspacePackages.entries()) {
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
      exclusionReason: exclusion.reason,
      kind: 'package-scope',
      packageJsonPath: normalizeAbsolutePath(
        path.join(workspacePackage.directory, 'package.json'),
      ),
      rootDir: normalizeAbsolutePath(workspacePackage.directory),
    });
  }

  const configRootDir = normalizeAbsolutePath(options.config.rootDir);
  const boundaryIndex = createWorkspaceRegionBoundaryIndex(boundaries);
  const excludedPackageRoots = options.workspacePackages.flatMap(
    (workspacePackage, index) =>
      exclusionsByCandidateKey.has(packageCandidates[index]?.key ?? '')
        ? [normalizeAbsolutePath(workspacePackage.directory)]
        : [],
  );
  const packages = options.workspacePackages.filter((workspacePackage) => {
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
    extendedPackageScopes: options.extendedPackageScopes.filter(
      (_scope, index) =>
        !exclusionsByCandidateKey.has(extendedCandidates[index]?.key ?? ''),
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
  const exclusionRules = compileRegionExclusionRules(config.regions?.exclude);

  validateRootPnpmWorkspaceExclusion({
    config,
    rules: exclusionRules,
  });

  const { outputIgnorePatterns, workspaceYamlPaths } =
    await collectNestedWorkspaceYamlPaths(config);
  const pnpmWorkspaceBoundaries = await collectPnpmWorkspaceBoundaries({
    config,
    provider: options.provider,
    rules: exclusionRules,
    workspaceYamlPaths,
  });
  const rawPackages = options.rawPackages
    ? [...options.rawPackages]
    : await options.provider(config);
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
  const excludedTopology = applyPackageRegionExclusions({
    config,
    extendedPackageScopes: packageScopeTopology.extendedPackageScopes,
    packageScopeBoundaries: packageScopeTopology.boundaries,
    pnpmWorkspaceBoundaries,
    rules: exclusionRules,
    workspacePackages: rawPackages,
  });

  validateRegionExclusionRules({ config, rules: exclusionRules });

  return {
    boundaries: excludedTopology.boundaries,
    extendedPackageScopes: excludedTopology.extendedPackageScopes,
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
