import type { ResolvedLiminaConfig } from '#config/runner';
import { normalizeAbsolutePath } from '#utils/path';
import { lstat, realpath } from 'node:fs/promises';
import path from 'pathe';
import { LiminaStructuredError } from '../../../check-reporting/errors';
import type { LiminaCheckIssue } from '../../../source-check/snapshot';
import type { WorkspacePackage } from '../actions';
import {
  createWorkspaceIssue,
  displayWorkspacePath,
  findNearestPnpmWorkspaceRoot,
  isMissingFsError,
} from './shared';
import type { WorkspacePackageIdentity } from './types';

function groupPackageIdentities(
  identities: readonly WorkspacePackageIdentity[],
): Map<string, WorkspacePackageIdentity[]> {
  const groups = new Map<string, WorkspacePackageIdentity[]>();
  for (const identity of identities) {
    const group = groups.get(identity.canonicalDirectory) ?? [];
    group.push(identity);
    groups.set(identity.canonicalDirectory, group);
  }
  return groups;
}

function createIdentityConflictIssue(options: {
  canonicalDirectory: string;
  config: ResolvedLiminaConfig;
  group: readonly WorkspacePackageIdentity[];
}): LiminaCheckIssue {
  return createWorkspaceIssue({
    code: 'LIMINA_WORKSPACE_PACKAGE_IDENTITY_CONFLICT',
    config: options.config,
    evidence: [
      `canonical root: ${options.canonicalDirectory}`,
      ...options.group.map(
        (identity) => `lexical root: ${identity.displayDirectory}`,
      ),
    ],
    filePath: path.join(options.group[0]!.package.directory, 'package.json'),
    fix: 'Remove duplicate or symlink-alias workspace package roots.',
    reason:
      'Two activated workspace package roots resolve to the same physical directory.',
    title: 'Workspace package identity conflict',
  });
}

export async function collectPackageIdentities(options: {
  config: ResolvedLiminaConfig;
  packages: readonly WorkspacePackage[];
}): Promise<WorkspacePackageIdentity[]> {
  const identities = await Promise.all(
    options.packages.map(async (workspacePackage) => ({
      canonicalDirectory: normalizeAbsolutePath(
        await realpath(workspacePackage.directory),
      ),
      displayDirectory: displayWorkspacePath(
        options.config.rootDir,
        workspacePackage.directory,
      ),
      package: workspacePackage,
    })),
  );
  const issues = [...groupPackageIdentities(identities)]
    .filter(([, group]) => group.length > 1)
    .map(([canonicalDirectory, group]) =>
      createIdentityConflictIssue({
        canonicalDirectory,
        config: options.config,
        group,
      }),
    );
  if (issues.length > 0) {
    throw new LiminaStructuredError('Workspace validation failed.', issues);
  }
  return identities;
}

async function hasWorkspaceDescriptor(
  workspaceYamlPath: string,
): Promise<boolean> {
  try {
    return (await lstat(workspaceYamlPath)).isFile();
  } catch (error) {
    if (isMissingFsError(error)) return false;
    throw error;
  }
}

function createSameRootOverlapIssue(options: {
  config: ResolvedLiminaConfig;
  packageRoot: string;
  workspaceYamlPath: string;
}): LiminaCheckIssue {
  return createWorkspaceIssue({
    code: 'LIMINA_WORKSPACE_REGION_OVERLAP',
    config: options.config,
    evidence: [
      `activated workspace package: ${displayWorkspacePath(options.config.rootDir, options.packageRoot)}`,
      `workspace descriptor: ${displayWorkspacePath(options.config.rootDir, options.workspaceYamlPath)}`,
    ],
    filePath: options.workspaceYamlPath,
    fix: 'Exclude the activated package from this run, remove its workspace membership, or remove the package-root pnpm-workspace.yaml.',
    reason:
      'An activated non-root workspace package is also the root of a pnpm workspace.',
    title: 'Workspace package and workspace root overlap',
  });
}

async function collectOverlapIssue(options: {
  config: ResolvedLiminaConfig;
  workspacePackage: WorkspacePackage;
  workspaceRootDir: string;
}): Promise<LiminaCheckIssue | null> {
  const packageRoot = normalizeAbsolutePath(options.workspacePackage.directory);
  if (packageRoot === options.workspaceRootDir) return null;
  const workspaceYamlPath = path.join(packageRoot, 'pnpm-workspace.yaml');
  if (!(await hasWorkspaceDescriptor(workspaceYamlPath))) return null;
  return createSameRootOverlapIssue({
    config: options.config,
    packageRoot,
    workspaceYamlPath,
  });
}

export async function assertNoSameRootOverlap(options: {
  config: ResolvedLiminaConfig;
  packages: readonly WorkspacePackage[];
}): Promise<void> {
  const workspaceRootDir = findNearestPnpmWorkspaceRoot(options.config.rootDir);
  const issues = (
    await Promise.all(
      options.packages.map((workspacePackage) =>
        collectOverlapIssue({
          config: options.config,
          workspacePackage,
          workspaceRootDir,
        }),
      ),
    )
  ).filter((issue): issue is LiminaCheckIssue => issue !== null);
  if (issues.length > 0) {
    throw new LiminaStructuredError('Workspace validation failed.', issues);
  }
}
