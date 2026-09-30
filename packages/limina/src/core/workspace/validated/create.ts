import type { ResolvedLiminaConfig } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import type { WorkspacePackage } from '../actions';
import type { ExtendedPackageScope, WorkspaceRegionBoundary } from '../regions';
import { collectPackageIsland } from './descriptors/island';
import { resolveStableDescriptors } from './descriptors/stability';
import {
  applyWorkspacePackageExclusions,
  compileExclusionRules,
  excludeTsconfigDescriptors,
  validatePackageScopeExclusions,
  validateWorkspacePackageExclusions,
} from './exclusions';
import { createValidatedOutputAuthorities } from './outputs/authorities';
import { collectOutputDeclarations } from './outputs/collection';
import {
  assertNoSameRootOverlap,
  collectPackageIdentities,
} from './package-identities';
import type {
  ValidatedWorkspaceContext,
  WorkspaceDescriptorCandidate,
  WorkspacePackageIdentity,
} from './types';

interface CollectedWorkspaceIslands {
  boundaries: WorkspaceRegionBoundary[];
  extendedPackageScopes: ExtendedPackageScope[];
  universe: WorkspaceDescriptorCandidate[];
}

async function collectWorkspaceIslands(options: {
  config: ResolvedLiminaConfig;
  identities: readonly WorkspacePackageIdentity[];
  packages: readonly WorkspacePackage[];
  rules: ReturnType<typeof compileExclusionRules>;
}): Promise<CollectedWorkspaceIslands> {
  const activatedIdentities = options.identities.filter((identity) =>
    options.packages.includes(identity.package),
  );
  const islands = await Promise.all(
    options.packages.map((owner) =>
      collectPackageIsland({
        activatedIdentities,
        activatedPackages: options.packages,
        config: options.config,
        owner,
        rules: options.rules,
      }),
    ),
  );
  return {
    boundaries: [
      ...islands.flatMap((island) => island.workspaceBoundaries),
      ...islands.flatMap((island) => island.boundaries),
    ],
    extendedPackageScopes: islands.flatMap((island) => island.extendedScopes),
    universe: islands.flatMap((island) => island.descriptors),
  };
}

function filterStableBoundaries(options: {
  boundaries: readonly WorkspaceRegionBoundary[];
  stablePaths: ReadonlySet<string>;
}): WorkspaceRegionBoundary[] {
  return options.boundaries.filter((boundary) => {
    const descriptorPath =
      boundary.kind === 'workspace-root'
        ? boundary.descriptor.path
        : boundary.packageJsonPath;
    return options.stablePaths.has(descriptorPath);
  });
}

function filterStableScopes(options: {
  scopes: readonly ExtendedPackageScope[];
  stablePaths: ReadonlySet<string>;
}): ExtendedPackageScope[] {
  return options.scopes.filter((scope) =>
    options.stablePaths.has(scope.packageJsonPath),
  );
}

function collectStableSourceConfigPaths(
  candidates: readonly WorkspaceDescriptorCandidate[],
): string[] {
  return candidates
    .filter((candidate) => candidate.kind === 'tsconfig')
    .map((candidate) => candidate.path)
    .sort(compareCodeUnits);
}

export async function collectWorkspaceInputSnapshot(options: {
  config: ResolvedLiminaConfig;
  rawPackages: readonly WorkspacePackage[];
}): Promise<{
  islands: Awaited<ReturnType<typeof collectWorkspaceIslands>>;
  packageIdentities: Awaited<ReturnType<typeof collectPackageIdentities>>;
  packages: WorkspacePackage[];
  activatedPackageRoots: string[];
  rules: ReturnType<typeof compileExclusionRules>;
}> {
  const rules = compileExclusionRules(options.config);
  validateWorkspacePackageExclusions({
    config: options.config,
    rawPackages: options.rawPackages,
    rules,
  });
  const packages = applyWorkspacePackageExclusions({
    config: options.config,
    rawPackages: options.rawPackages,
    rules,
  });
  await assertNoSameRootOverlap({ config: options.config, packages });
  const packageIdentities = await collectPackageIdentities({
    config: options.config,
    packages,
  });
  const islands = await collectWorkspaceIslands({
    config: options.config,
    identities: packageIdentities,
    packages,
    rules,
  });
  const activatedPackageRoots = packages.map((workspacePackage) =>
    normalizeAbsolutePath(workspacePackage.directory),
  );
  return { islands, packageIdentities, packages, activatedPackageRoots, rules };
}

export async function collectValidatedWorkspaceContext(options: {
  config: ResolvedLiminaConfig;
  rawPackages: readonly WorkspacePackage[];
}): Promise<ValidatedWorkspaceContext> {
  const { islands, packageIdentities, packages, activatedPackageRoots, rules } =
    await collectWorkspaceInputSnapshot(options);
  const governanceRoot = options.config.governanceRoot;
  const universe = excludeTsconfigDescriptors({
    config: options.config,
    candidates: islands.universe,
  });
  const declarations = await collectOutputDeclarations({
    activatedPackageRoots,
    config: options.config,
    universe,
  });
  const packageBoundaries = islands.boundaries.filter(
    (boundary) => boundary.kind === 'package-scope',
  );
  const stable = resolveStableDescriptors({
    config: options.config,
    explicitOutputs: declarations.explicitOutputs,
    packageBoundaries,
    packageOutputs: declarations.packageOutputs,
    universe,
  });
  validatePackageScopeExclusions({
    config: options.config,
    rules,
    stableCandidates: stable.candidates,
    workspaceBoundaries: islands.boundaries.filter(
      (boundary) => boundary.kind === 'workspace-root',
    ),
  });
  const stablePaths = new Set(
    stable.candidates.map((candidate) => candidate.path),
  );
  const sourceConfigPaths = collectStableSourceConfigPaths(stable.candidates);
  const authorities = await createValidatedOutputAuthorities({
    activatedPackageRoots,
    config: options.config,
    declarations,
    stableSourceConfigPaths: new Set(sourceConfigPaths),
  });
  return {
    boundaries: filterStableBoundaries({
      boundaries: islands.boundaries,
      stablePaths,
    }),
    configRootDir: normalizeAbsolutePath(options.config.rootDir),
    descriptorCandidates: stable.candidates,
    extendedPackageScopes: filterStableScopes({
      scopes: islands.extendedPackageScopes,
      stablePaths,
    }),
    outputMutationAuthorities: authorities.outputMutationAuthorities,
    outputRoots: [...stable.outputs].sort(compareCodeUnits),
    packageIdentities,
    packages,
    rawPackages: [...options.rawPackages],
    sourceConfigPaths,
    workspaceMutationGeneration: authorities.workspaceMutationGeneration,
    governanceRoot,
    workspaceRootDir: governanceRoot.rootDir,
  };
}
