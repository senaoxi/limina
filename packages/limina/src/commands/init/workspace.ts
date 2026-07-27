import {
  collectWorkspacePackages,
  type PackageManifest,
  readJsonFile,
  type WorkspacePackage,
} from '#core/workspace/actions';
import { normalizeAbsolutePath } from '#utils/path';
import { existsSync } from 'node:fs';
import path from 'pathe';
import { confirmAction } from './prompts';
import { createInitConfig, pnpmWorkspaceFileName } from './shared';
import type { InitPromptOptions } from './types';

function findWorkspaceRootFrom(directory: string): string | null {
  if (existsSync(path.join(directory, pnpmWorkspaceFileName))) {
    return normalizeAbsolutePath(directory);
  }

  const parentDirectory = path.dirname(directory);
  if (parentDirectory === directory) {
    return null;
  }

  return findWorkspaceRootFrom(parentDirectory);
}

export function findPnpmWorkspaceRoot(startDir: string): string | null {
  return findWorkspaceRootFrom(path.resolve(startDir));
}

function getWorkspaceRootOrThrow(cwd: string): string {
  const rootDir = findPnpmWorkspaceRoot(cwd);
  if (rootDir !== null) {
    return rootDir;
  }

  throw new Error(
    `Unable to run limina init from ${cwd}: no pnpm-workspace.yaml was found in this directory or its parents.`,
  );
}

function readRootPackageName(rootDir: string): string | undefined {
  const packageJsonPath = path.join(rootDir, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return undefined;
  }

  return readJsonFile<PackageManifest>(packageJsonPath).name;
}

function formatWorkspacePrompt(
  rootDir: string,
  packageName: string | undefined,
): string {
  const packageLabel = packageName === undefined ? '' : `"${packageName}" `;
  return `Use pnpm workspace ${packageLabel}at ${rootDir}?`;
}

export async function resolveInitWorkspace(options: {
  cwd: string;
  prompt: InitPromptOptions;
}): Promise<{ rootDir: string }> {
  const rootDir = getWorkspaceRootOrThrow(options.cwd);
  const shouldUseRoot = await confirmAction({
    message: formatWorkspacePrompt(rootDir, readRootPackageName(rootDir)),
    prompt: options.prompt,
  });
  if (!shouldUseRoot) {
    throw new Error('limina init canceled.');
  }

  return { rootDir };
}

export async function collectInitWorkspacePackages(
  rootDir: string,
): Promise<WorkspacePackage[]> {
  const config = createInitConfig(rootDir);
  const packages = await collectWorkspacePackages(config);
  return packages.filter(
    (workspacePackage) => workspacePackage.directory !== rootDir,
  );
}
