import { isPathInsideDirectory } from '#utils/path';
import { resolveNearestWorkspaceRoot } from '#utils/workspace-root';
import { existsSync } from 'node:fs';
import path from 'pathe';

export const DEFAULT_LIMINA_CONFIG_FILES = [
  'limina.config.mts',
  'limina.config.mjs',
  'limina.config.ts',
  'limina.config.js',
] as const;

function getParentDirectory(directory: string): string | undefined {
  const parent = path.dirname(directory);
  return parent === directory ? undefined : parent;
}

function findDefaultConfigInDirectory(directory: string): string | undefined {
  return DEFAULT_LIMINA_CONFIG_FILES.map((fileName) =>
    path.join(directory, fileName),
  ).find(existsSync);
}

function inspectInsideWorkspaceDirectory(
  directory: string,
  workspaceRootDir: string,
): string | null | undefined {
  const configPath = findDefaultConfigInDirectory(directory);
  if (configPath !== undefined) return configPath;
  return directory === workspaceRootDir ? null : undefined;
}

function inspectConfigDirectory(
  directory: string,
  workspaceRootDir: string,
): string | null | undefined {
  if (!isPathInsideDirectory(directory, workspaceRootDir)) return null;
  return inspectInsideWorkspaceDirectory(directory, workspaceRootDir);
}

export function findLiminaConfigPath(
  startDir: string,
  rootDir: string,
): string | null {
  let currentDir: string | undefined = path.resolve(startDir);
  const workspaceRootDir = path.resolve(rootDir);
  while (currentDir !== undefined) {
    const result = inspectConfigDirectory(currentDir, workspaceRootDir);
    if (result !== undefined) return result;
    currentDir = getParentDirectory(currentDir);
  }
  return null;
}

export function inferWorkspaceRoot(startDir: string): string {
  return resolveNearestWorkspaceRoot(startDir).rootDir;
}

export function validateConfigPathInsideWorkspace(
  configPath: string,
  rootDir: string,
): void {
  if (isPathInsideDirectory(configPath, rootDir)) return;
  throw new Error(
    [
      `Unable to load Limina config at ${configPath}:`,
      `config file must be inside the governed workspace at ${rootDir}.`,
    ].join(' '),
  );
}

export function formatDefaultConfigFileList(): string {
  return DEFAULT_LIMINA_CONFIG_FILES.map((fileName) => `"${fileName}"`).join(
    ', ',
  );
}
