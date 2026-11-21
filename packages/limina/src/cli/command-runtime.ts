import { assertConfigLoaderStartup } from '#config/loader-identity';
import {
  type LiminaCommand,
  loadConfig,
  type ResolvedLiminaConfig,
} from '#config/runner';
import { createRequire } from 'node:module';
import path from 'pathe';
import { currentProfile } from '../application/analysis/observability';
import {
  createGlobalQueryCommandContext,
  type GlobalQueryCommandContext,
} from '../check-reporting/standalone-invocation-command';
import { parseConfigLoader } from './parse';
import { bindCliProfileRoot, observeCliPhase } from './profiling';
import type { GlobalFlags } from './types';

export interface StandaloneCommandContext {
  commandContext: GlobalQueryCommandContext;
  config: ResolvedLiminaConfig;
}

function getConfigMode(flags: GlobalFlags): string {
  if (flags.mode !== undefined) return flags.mode;
  return process.env.NODE_ENV === undefined ? 'default' : process.env.NODE_ENV;
}

function cliConfigLoader(flags: GlobalFlags) {
  const loader = parseConfigLoader(flags.configLoader) ?? 'native';
  assertConfigLoaderStartup(loader);
  return loader;
}
export async function loadCliConfig(
  flags: GlobalFlags,
  command: LiminaCommand,
): Promise<ResolvedLiminaConfig> {
  return loadObservedConfig({
    command,
    configLoader: cliConfigLoader(flags),
    configPath: flags.config,
    cwd: process.cwd(),
    mode: flags.mode,
  });
}

function loadObservedConfig(
  options: Parameters<typeof loadConfig>[0],
): Promise<ResolvedLiminaConfig> {
  const observer = currentProfile();
  return observer === undefined
    ? loadConfig(options)
    : observeCliPhase('cli.config-load', () =>
        loadConfig(options, bindCliProfileRoot),
      );
}

export async function loadStandaloneContext(
  flags: GlobalFlags,
  command: LiminaCommand,
): Promise<StandaloneCommandContext> {
  const configLoader = cliConfigLoader(flags);
  const mode = getConfigMode(flags);
  const config = await loadObservedConfig({
    command,
    configLoader,
    configPath: flags.config,
    cwd: process.cwd(),
    mode,
  });
  const manifestPath = createRequire(import.meta.url).resolve(
    'limina/package.json',
  );
  const cliEntryPath = path.join(path.dirname(manifestPath), 'bin/limina.js');
  return {
    commandContext: createGlobalQueryCommandContext({
      cliEntryPath,
      configLoader,
      configPath: config.configPath,
      mode,
      nodeExecutablePath: process.execPath,
      workspaceRoot: config.rootDir,
    }),
    config,
  };
}
