import {
  type LiminaCommand,
  loadConfig,
  type ResolvedLiminaConfig,
} from '#config/runner';
import { fileURLToPath } from 'node:url';
import {
  createGlobalQueryCommandContext,
  type GlobalQueryCommandContext,
} from '../check-reporting/standalone-invocation-command';
import { parseConfigLoader } from './parse';
import type { GlobalFlags, MigrationFlags } from './types';

export interface StandaloneCommandContext {
  commandContext: GlobalQueryCommandContext;
  config: ResolvedLiminaConfig;
}

function getConfigMode(flags: GlobalFlags): string {
  if (flags.mode !== undefined) return flags.mode;
  if (process.env.NODE_ENV !== undefined) return process.env.NODE_ENV;
  return 'default';
}

export async function loadCliConfig(
  flags: GlobalFlags,
  command: LiminaCommand,
): Promise<ResolvedLiminaConfig> {
  return loadConfig({
    command,
    configLoader: parseConfigLoader(flags.configLoader),
    configPath: flags.config,
    cwd: process.cwd(),
    mode: flags.mode,
  });
}

export async function loadStandaloneContext(
  flags: GlobalFlags,
  command: LiminaCommand,
): Promise<StandaloneCommandContext> {
  const configLoader = parseConfigLoader(flags.configLoader) ?? 'native';
  const mode = getConfigMode(flags);
  const config = await loadConfig({
    command,
    configLoader,
    configPath: flags.config,
    cwd: process.cwd(),
    mode,
  });
  return {
    commandContext: createGlobalQueryCommandContext({
      cliEntryPath: process.argv[1] ?? fileURLToPath(import.meta.url),
      configLoader,
      configPath: config.configPath,
      mode,
      nodeExecutablePath: process.execPath,
      workspaceRoot: config.rootDir,
    }),
    config,
  };
}

function isMissingLiminaConfigError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.toLowerCase().includes('unable to find limina config');
}

export async function loadMigrationConfig(
  flags: MigrationFlags,
): Promise<ResolvedLiminaConfig> {
  try {
    return await loadCliConfig(flags, 'migration');
  } catch (error) {
    if (!isMissingLiminaConfigError(error)) throw error;
    throw new Error(
      'Run npx limina init first, then rerun npx limina migration.',
      { cause: error },
    );
  }
}
