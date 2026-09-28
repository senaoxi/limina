import { ancestorDirectories } from '#utils/ancestor-directories';
import { existsSync } from 'node:fs';
import path from 'pathe';

export const DEFAULT_LIMINA_CONFIG_FILES = [
  'limina.config.mts',
  'limina.config.mjs',
  'limina.config.ts',
  'limina.config.js',
] as const;

/** Config discovery is independent of package and workspace classification. */
export function findLiminaConfigPath(startDir: string): string | null {
  for (const directory of ancestorDirectories(startDir)) {
    const configPath = findLocalConfig(directory);
    if (configPath !== undefined) return configPath;
  }
  return null;
}

function findLocalConfig(directory: string): string | undefined {
  return DEFAULT_LIMINA_CONFIG_FILES.map((name) =>
    path.join(directory, name),
  ).find(existsSync);
}

function requireDefaultConfig(cwd: string): string {
  const configPath = findLiminaConfigPath(cwd);
  if (configPath === null)
    throw new Error(
      `Unable to find limina config. Searched for ${formatDefaultConfigFileList()} from ${cwd} through its ancestors.`,
    );
  return configPath;
}

export function formatDefaultConfigFileList(): string {
  return DEFAULT_LIMINA_CONFIG_FILES.map((name) => `"${name}"`).join(', ');
}

export interface QueryConfigAnchor {
  readonly configPath: string;
}

export interface ExecutionConfigLocation extends QueryConfigAnchor {
  readonly exists: true;
}

/** An explicit query anchor need not still exist on disk. */
export function resolveQueryConfigAnchor(options: {
  cwd?: string;
  configPath?: string;
}): QueryConfigAnchor {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  if (options.configPath !== undefined)
    return { configPath: path.resolve(cwd, options.configPath) };
  return { configPath: requireDefaultConfig(cwd) };
}

export function resolveExecutionConfigLocation(options: {
  cwd?: string;
  configPath?: string;
}): ExecutionConfigLocation {
  const anchor = resolveQueryConfigAnchor(options);
  if (!existsSync(anchor.configPath))
    throw new Error(`Unable to find limina config at ${anchor.configPath}`);
  return { ...anchor, exists: true };
}
