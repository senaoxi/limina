import { resolveGovernanceRoot } from '#utils/workspace-root';
import { bindConfigInputs, observeConfigLoad } from './input-observation';
import { captureInvocationData } from './invocation-data';
import { loadConfigModule } from './loader-import';
import { resolveExecutionConfigLocation } from './loader-paths';
import type {
  LiminaConfig,
  LiminaConfigEnvironment,
  LiminaConfigFunction,
  LoadConfigOptions,
  ResolvedLiminaConfig,
} from './root-types';
import { normalizeConfig } from './runtime';

async function resolveConfigExport(
  configExport: unknown,
  configEnvironment_: LiminaConfigEnvironment,
): Promise<LiminaConfig> {
  return captureInvocationData(
    normalizeConfig(
      typeof configExport === 'function'
        ? await (configExport as LiminaConfigFunction)(configEnvironment_)
        : await configExport,
    ),
  );
}

function configEnvironment(
  options: LoadConfigOptions,
): LiminaConfigEnvironment {
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
  const loaded = await observeConfigLoad(
    location.configPath,
    async () =>
      resolveConfigExport(
        await loadConfigModule(location.configPath, options.configLoader),
        configEnvironment(options),
      ),
    [governanceRoot.manifestPath],
  );
  return bindConfigInputs(
    captureInvocationData({
      ...loaded.value,
      configPath: location.configPath,
      governanceRoot,
      rootDir: governanceRoot.rootDir,
    }),
    loaded.inputs,
  );
}
