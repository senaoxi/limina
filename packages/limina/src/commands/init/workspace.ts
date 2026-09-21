import type {
  PackageManifest,
  WorkspacePackage,
} from '#core/workspace/actions';
import {
  collectWorkspacePackages,
  readJsonFile,
} from '#core/workspace/actions';
import type {
  ResolvedWorkspaceRoot,
  SupportedPackageManager,
} from '#utils/workspace-root';
import { resolveNearestWorkspaceRoot } from '#utils/workspace-root';
import { existsSync } from 'node:fs';
import path from 'pathe';
import { confirmAction } from './prompts';
import { createInitConfig } from './shared';
import type { InitPromptOptions } from './types';

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
  manager: SupportedPackageManager,
): string {
  const packageLabel = packageName === undefined ? '' : `"${packageName}" `;
  return `Use ${manager} workspace ${packageLabel}at ${rootDir}?`;
}

export async function resolveInitWorkspace(options: {
  cwd: string;
  prompt: InitPromptOptions;
}): Promise<ResolvedWorkspaceRoot> {
  const workspace = resolveNearestWorkspaceRoot(options.cwd);
  const { rootDir, packageManager } = workspace;
  const shouldUseRoot = await confirmAction({
    message: formatWorkspacePrompt(
      rootDir,
      readRootPackageName(rootDir),
      packageManager,
    ),
    prompt: options.prompt,
  });
  if (!shouldUseRoot) {
    throw new Error('limina init canceled.');
  }

  return workspace;
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

export const initCommands: Record<SupportedPackageManager, { build: string }> =
  {
    pnpm: { build: 'pnpm limina:build' },
    npm: { build: 'npm run limina:build' },
    yarn: { build: 'yarn limina:build' },
    bun: { build: 'bun run limina:build' },
  };
