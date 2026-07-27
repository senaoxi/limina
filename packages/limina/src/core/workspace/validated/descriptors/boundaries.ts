import type { ResolvedLiminaConfig } from '#config/runner';
import { readFile } from 'node:fs/promises';
import path from 'pathe';
import type { PackageManifest } from '../../actions';
import { type CompiledExclusionRule, findExactExclusions } from '../exclusions';
import { createDescriptorCandidate } from '../shared';
import type { DirectoryEntryStats, IslandWalkContext } from './types';

function hasFileEntry(
  names: ReadonlyMap<string, DirectoryEntryStats>,
  name: string,
): boolean {
  const stats = names.get(name);
  if (stats === undefined) return false;
  return stats.isFile();
}

async function readPackageManifest(
  packageJsonPath: string,
): Promise<PackageManifest | null> {
  try {
    return JSON.parse(
      (await readFile(packageJsonPath, 'utf8')).replace(/^\uFEFF/u, ''),
    ) as PackageManifest;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function addNestedWorkspaceBoundary(options: {
  context: IslandWalkContext;
  directory: string;
  workspaceYamlPath: string;
}): void {
  options.context.result.pnpmBoundaries.push({
    inspection: {
      reason: 'Nested workspace context is discovered independently.',
      status: 'excluded',
    },
    kind: 'pnpm-workspace',
    rootDir: options.directory,
    workspaceYamlPath: options.workspaceYamlPath,
  });
}

export async function addWorkspaceDescriptor(options: {
  context: IslandWalkContext;
  directory: string;
  isOwnerRoot: boolean;
  names: ReadonlyMap<string, DirectoryEntryStats>;
}): Promise<boolean> {
  if (!hasFileEntry(options.names, 'pnpm-workspace.yaml')) return false;
  const workspaceYamlPath = path.join(options.directory, 'pnpm-workspace.yaml');
  options.context.result.descriptors.push(
    await createDescriptorCandidate({
      config: options.context.config,
      kind: 'pnpm-workspace',
      ownerDirectory: options.context.ownerRootDir,
      path: workspaceYamlPath,
      rootDir: options.directory,
    }),
  );
  if (options.isOwnerRoot) return false;
  addNestedWorkspaceBoundary({
    context: options.context,
    directory: options.directory,
    workspaceYamlPath,
  });
  return true;
}

function isNestedScopeExtensionEnabled(config: ResolvedLiminaConfig): boolean {
  return config.regions?.extendNestedPackageScopes === true;
}

function shouldExtendPackageScope(options: {
  config: ResolvedLiminaConfig;
  manifest: PackageManifest | null;
}): boolean {
  if (!isNestedScopeExtensionEnabled(options.config)) return false;
  if (options.manifest === null) return false;
  return !Object.hasOwn(options.manifest, 'name');
}

function addExtendedScope(options: {
  context: IslandWalkContext;
  directory: string;
  packageJsonPath: string;
}): void {
  options.context.result.extendedScopes.push({
    ownerDirectory: options.context.ownerRootDir,
    packageJsonPath: options.packageJsonPath,
    rootDir: options.directory,
  });
}

function addPackageBoundary(options: {
  context: IslandWalkContext;
  directory: string;
  exclusion: CompiledExclusionRule | undefined;
  packageJsonPath: string;
}): void {
  const exclusionReason = options.exclusion?.entry.reason;
  options.context.result.boundaries.push({
    excluded: options.exclusion !== undefined,
    ...(exclusionReason === undefined ? {} : { exclusionReason }),
    kind: 'package-scope',
    packageJsonPath: options.packageJsonPath,
    rootDir: options.directory,
  });
}

async function processNestedPackageScope(options: {
  context: IslandWalkContext;
  directory: string;
  packageJsonPath: string;
}): Promise<boolean> {
  const manifest = await readPackageManifest(options.packageJsonPath);
  const exclusion = findExactExclusions({
    config: options.context.config,
    kind: 'package-scope',
    rootDir: options.directory,
    rules: options.context.rules,
  })[0];
  const extend = shouldExtendPackageScope({
    config: options.context.config,
    manifest,
  });
  if (extend && exclusion === undefined) {
    addExtendedScope(options);
    return false;
  }
  addPackageBoundary({ ...options, exclusion });
  return true;
}

export async function addPackageDescriptor(options: {
  context: IslandWalkContext;
  directory: string;
  isOwnerRoot: boolean;
  names: ReadonlyMap<string, DirectoryEntryStats>;
}): Promise<boolean> {
  if (!hasFileEntry(options.names, 'package.json')) return false;
  const packageJsonPath = path.join(options.directory, 'package.json');
  options.context.result.descriptors.push(
    await createDescriptorCandidate({
      config: options.context.config,
      kind: 'package-json',
      ownerDirectory: options.context.ownerRootDir,
      path: packageJsonPath,
      rootDir: options.directory,
    }),
  );
  if (options.isOwnerRoot) return false;
  return processNestedPackageScope({
    context: options.context,
    directory: options.directory,
    packageJsonPath,
  });
}
