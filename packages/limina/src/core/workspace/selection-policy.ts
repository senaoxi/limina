import type {
  ResolvedWorkspaceRoot,
  SupportedPackageManager,
} from '#utils/workspace-root';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import {
  bunPackageGlobGroups,
  nonPruningGlobGroup,
  npmPackageGlobs,
} from './selection-patterns';

export interface WorkspacePackageGlobGroup {
  packageGlobs: readonly string[];
  acceptsDirectory?: (relativeDirectory: string) => boolean;
}

export interface WorkspacePackageSelectionPolicy {
  packageGlobs: readonly string[];
  globGroups?: readonly WorkspacePackageGlobGroup[];
  hardIgnores: readonly string[];
}

export interface WorkspacePackageManagerAdapter {
  readonly packageManager: SupportedPackageManager;
  readSelectionPolicy(
    workspace: ResolvedWorkspaceRoot,
  ): Promise<WorkspacePackageSelectionPolicy>;
}

function validateGlobs(
  value: unknown,
  manager: SupportedPackageManager,
): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === 'string')
  ) {
    throw new Error(
      `Invalid ${manager} workspace declaration: expected a string array.`,
    );
  }
  return value;
}

function readPackagesField(value: unknown): unknown {
  if (!isObject(value)) return undefined;
  return Object.hasOwn(value, 'packages')
    ? (value as { packages: unknown }).packages
    : undefined;
}

async function readPnpmGlobs(
  workspace: ResolvedWorkspaceRoot,
): Promise<string[]> {
  const manifest: unknown = parse(
    await readFile(workspace.descriptor.path, 'utf8'),
  );
  const packages = readPackagesField(manifest);
  return packages === undefined ? [] : validateGlobs(packages, 'pnpm');
}

function readManifestGlobs(workspace: ResolvedWorkspaceRoot): string[] {
  const declaration = workspace.manifest.workspaces;
  const value =
    workspace.packageManager === 'npm' || Array.isArray(declaration)
      ? declaration
      : readPackagesField(declaration);
  return validateGlobs(value, workspace.packageManager);
}

function manifestAdapter(
  packageManager: SupportedPackageManager,
  hardIgnores: readonly string[],
): WorkspacePackageManagerAdapter {
  return {
    packageManager,
    async readSelectionPolicy(workspace) {
      return { packageGlobs: readManifestGlobs(workspace), hardIgnores };
    },
  };
}

export const workspacePackageManagerAdapters: Record<
  SupportedPackageManager,
  WorkspacePackageManagerAdapter
> = {
  pnpm: {
    packageManager: 'pnpm',
    async readSelectionPolicy(workspace) {
      const packageGlobs = await readPnpmGlobs(workspace);
      return {
        packageGlobs,
        globGroups: [nonPruningGlobGroup(packageGlobs, workspace.rootDir)],
        hardIgnores: ['**/node_modules/**', '**/bower_components/**'],
      };
    },
  },
  npm: {
    packageManager: 'npm',
    async readSelectionPolicy(workspace) {
      const packageGlobs = npmPackageGlobs(readManifestGlobs(workspace));
      return {
        packageGlobs,
        globGroups: [nonPruningGlobGroup(packageGlobs, workspace.rootDir)],
        hardIgnores: ['**/node_modules/**'],
      };
    },
  },
  yarn: manifestAdapter('yarn', [
    '**/node_modules/**',
    '**/.git/**',
    '**/.yarn/**',
  ]),
  bun: {
    packageManager: 'bun',
    async readSelectionPolicy(workspace) {
      const packageGlobs = readManifestGlobs(workspace);
      return {
        packageGlobs,
        globGroups: bunPackageGlobGroups(packageGlobs).map((group) =>
          nonPruningGlobGroup(group, workspace.rootDir),
        ),
        hardIgnores: ['**/node_modules/**', '**/.git/**', '**/CMakeFiles/**'],
      };
    },
  },
};

function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}
