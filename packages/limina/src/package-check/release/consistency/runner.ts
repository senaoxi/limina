import type { ResolvedLiminaConfig } from '#config/runner';
import {
  isNamedWorkspacePackage,
  type NamedWorkspacePackage,
} from '#core/workspace/actions';
import path from 'pathe';
import { getPackedContentFiles, unpackPackedPackage } from '../packed/archive';
import {
  readPackedPackageJson,
  validatePackedManifestLint,
} from '../packed/json';
import { validatePackedManifest } from '../packed/manifest';
import { validateReleaseTarballHygiene } from '../tarball-hygiene';
import { visitWorkspacePackageDependencies } from '../workspace/dependencies';
import { createReleaseConsistencyState } from './dependencies';
import { createReleaseConsistencyError } from './error';
import type {
  AssertPackageReleaseConsistencyOptions,
  PackedPackageContentFile,
  PublishManifest,
  ReleaseConsistencyState,
} from './types';

interface ReleaseConsistencyContext {
  options: AssertPackageReleaseConsistencyOptions;
  packageManifestPath: string;
  packedManifestPath: string;
  state: ReleaseConsistencyState;
  tarballPath: string;
  workspacePackages: NamedWorkspacePackage[];
}

function createContext(
  options: AssertPackageReleaseConsistencyOptions,
): ReleaseConsistencyContext {
  const tarballPath = path.basename(options.packedTarballPath);
  return {
    options,
    packageManifestPath: path.join(options.outDir, 'package.json'),
    packedManifestPath: `${tarballPath}#package.json`,
    state: createReleaseConsistencyState(),
    tarballPath,
    workspacePackages: options.workspacePackages.filter(
      isNamedWorkspacePackage,
    ),
  };
}

function findSourcePackage(
  context: ReleaseConsistencyContext,
): NamedWorkspacePackage | undefined {
  return context.workspacePackages.find(
    (workspacePackage) =>
      workspacePackage.name === context.options.outputManifest.name,
  );
}

function createWorkspacePackageIndex(
  packages: readonly NamedWorkspacePackage[],
): Map<string, NamedWorkspacePackage> {
  return new Map(
    packages.map((workspacePackage) => [
      workspacePackage.name,
      workspacePackage,
    ]),
  );
}

async function validateWorkspaceDependencies(
  context: ReleaseConsistencyContext,
): Promise<void> {
  const sourcePackage = findSourcePackage(context);
  if (sourcePackage === undefined) return;
  context.state.visitedPackages.add(sourcePackage.name);
  await visitWorkspacePackageDependencies({
    config: context.options.config,
    importerName: sourcePackage.name,
    isRoot: true,
    manifest: sourcePackage.manifest,
    manifestPath: path.join(sourcePackage.directory, 'package.json'),
    state: context.state,
    workspacePackagesByName: createWorkspacePackageIndex(
      context.workspacePackages,
    ),
  });
}

async function readPackedManifest(context: ReleaseConsistencyContext): Promise<{
  contentFiles: PackedPackageContentFile[];
  manifest: PublishManifest | null;
}> {
  const packedPackage = await unpackPackedPackage(
    context.options.packedTarball,
  );
  const contentFiles = getPackedContentFiles(packedPackage);
  validateReleaseTarballHygiene({
    contentFiles,
    outDir: context.options.outDir,
    packageManifestPath: context.packageManifestPath,
    rootPackageName: context.options.outputManifest.name,
    state: context.state,
    tarballPath: context.tarballPath,
  });
  return {
    contentFiles,
    manifest: readPackedPackageJson({
      contentFiles,
      packageManifestPath: context.packageManifestPath,
      rootPackageName: context.options.outputManifest.name,
      state: context.state,
      tarballPath: context.tarballPath,
    }),
  };
}

function getReleaseConfig(context: ReleaseConsistencyContext) {
  return context.options.config.release;
}

function getConfiguredManifestLint(context: ReleaseConsistencyContext) {
  const release = getReleaseConfig(context);
  return release === undefined ? undefined : release.npmPackageJsonLint;
}

type PackedManifestLintConfig = NonNullable<
  NonNullable<ResolvedLiminaConfig['release']>['npmPackageJsonLint']
>;

function getPackedManifestLintConfig(
  context: ReleaseConsistencyContext,
): PackedManifestLintConfig | null {
  const config = getConfiguredManifestLint(context);
  if (config === undefined) return null;
  if (config === false) return null;
  return config;
}

async function validateOptionalManifestLint(options: {
  context: ReleaseConsistencyContext;
  manifest: PublishManifest;
}): Promise<void> {
  const lintConfig = getPackedManifestLintConfig(options.context);
  if (lintConfig === null) return;
  await validatePackedManifestLint({
    config: options.context.options.config,
    lintConfig,
    manifest: options.manifest,
    outDir: options.context.options.outDir,
    packedManifestPath: options.context.packedManifestPath,
    packageManifestPath: options.context.packageManifestPath,
    rootPackageName: options.context.options.outputManifest.name,
    state: options.context.state,
  });
}

async function validatePackedArtifact(
  context: ReleaseConsistencyContext,
): Promise<void> {
  const { manifest } = await readPackedManifest(context);
  if (manifest === null) return;
  await validateOptionalManifestLint({ context, manifest });
  validatePackedManifest({
    manifest,
    packedManifestPath: context.packedManifestPath,
    packageManifestPath: context.packageManifestPath,
    rootPackageName: context.options.outputManifest.name,
    state: context.state,
  });
}

function throwConsistencyError(context: ReleaseConsistencyContext): void {
  const error = createReleaseConsistencyError({
    label: context.options.label,
    outDir: context.options.outDir,
    rootDir: context.options.config.rootDir,
    rootPackageName: context.options.outputManifest.name,
    state: context.state,
  });
  if (error !== null) throw error;
}

export async function assertPackageReleaseConsistency(
  options: AssertPackageReleaseConsistencyOptions,
): Promise<void> {
  const context = createContext(options);
  await validateWorkspaceDependencies(context);
  await validatePackedArtifact(context);
  throwConsistencyError(context);
}
