import type { ResolvedLiminaConfig } from '#config/runner';
import {
  hasWorkspaceDeclaration,
  type WorkspaceRootDescriptor,
} from '#utils/workspace-root';
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
  return stats !== undefined && stats.isFile();
}

async function readPackageManifest(
  packageJsonPath: string,
): Promise<PackageManifest | null> {
  try {
    return JSON.parse(
      (await readFile(packageJsonPath, 'utf8')).replace(/^\u{FEFF}/u, ''),
    ) as PackageManifest;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function addNestedWorkspaceBoundary(options: {
  context: IslandWalkContext;
  directory: string;
  descriptor: WorkspaceRootDescriptor;
}): void {
  options.context.result.workspaceBoundaries.push({
    inspection: {
      reason: 'Nested workspace context is discovered independently.',
      status: 'excluded',
    },
    kind: 'workspace-root',
    rootDir: options.directory,
    descriptor: options.descriptor,
  });
}

export async function isAddWorkspaceDescriptor(options: {
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
    descriptor: { kind: 'pnpm-workspace', path: workspaceYamlPath },
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
  return (
    isNestedScopeExtensionEnabled(options.config) &&
    options.manifest !== null &&
    !Object.hasOwn(options.manifest, 'name')
  );
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
    ...(exclusionReason !== undefined && { exclusionReason }),
    kind: 'package-scope',
    packageJsonPath: options.packageJsonPath,
    rootDir: options.directory,
  });
}

async function isProcessNestedPackageScope(options: {
  context: IslandWalkContext;
  directory: string;
  packageJsonPath: string;
}): Promise<boolean> {
  const manifest = await readPackageManifest(options.packageJsonPath);
  return (
    isAddManifestWorkspaceBoundary({ ...options, manifest }) ||
    isProcessOrdinaryPackageScope({ ...options, manifest })
  );
}

function isProcessOrdinaryPackageScope(options: {
  context: IslandWalkContext;
  directory: string;
  packageJsonPath: string;
  manifest: PackageManifest | null;
}): boolean {
  const { manifest } = options;
  const exclusion = findExactExclusions({
    config: options.context.config,
    kind: 'package-scope',
    rootDir: options.directory,
    rules: options.context.rules,
  })[0];
  const isExtend = shouldExtendPackageScope({
    config: options.context.config,
    manifest,
  });
  if (isExtend && exclusion === undefined) {
    addExtendedScope(options);
    return false;
  }
  addPackageBoundary({ ...options, exclusion });
  return true;
}

export async function isAddPackageDescriptor(options: {
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
  return isProcessNestedPackageScope({
    context: options.context,
    directory: options.directory,
    packageJsonPath,
  });
}

function isAddManifestWorkspaceBoundary(options: {
  context: IslandWalkContext;
  directory: string;
  packageJsonPath: string;
  manifest: PackageManifest | null;
}): boolean {
  if (options.manifest === null || !hasWorkspaceDeclaration(options.manifest))
    return false;
  addNestedWorkspaceBoundary({
    context: options.context,
    directory: options.directory,
    descriptor: {
      kind: 'package-json-workspaces',
      path: options.packageJsonPath,
    },
  });
  return true;
}
