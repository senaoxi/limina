import { resolveGovernanceRoot } from '#utils/workspace-root';
import { loadConfigModule } from './loader-import';
import { resolveExecutionConfigLocation } from './loader-paths';
import type {
  LiminaConfig,
  LiminaConfigEnv,
  LiminaConfigFn,
  LoadConfigOptions,
  ResolvedLiminaConfig,
} from './root-types';
import { normalizeConfig } from './runtime';

async function resolveConfigExport(
  configExport: unknown,
  configEnv: LiminaConfigEnv,
): Promise<LiminaConfig> {
  if (typeof configExport === 'function')
    return normalizeConfig(await (configExport as LiminaConfigFn)(configEnv));
  return normalizeConfig(await configExport);
}

function configEnvironment(options: LoadConfigOptions): LiminaConfigEnv {
  return { command: options.command ?? 'check', mode: configMode(options) };
}
function configMode(options: LoadConfigOptions): string {
  return options.mode ?? process.env.NODE_ENV ?? 'default';
}

export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<ResolvedLiminaConfig> {
  const location = resolveExecutionConfigLocation(options);
  const governanceRoot = resolveGovernanceRoot(location.configPath);
  const config = await resolveConfigExport(
    await loadConfigModule(location.configPath, options.configLoader),
    configEnvironment(options),
  );
  return {
    ...config,
    configPath: location.configPath,
    governanceRoot,
    rootDir: governanceRoot.rootDir,
  };
}
