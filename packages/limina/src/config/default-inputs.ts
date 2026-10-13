import type { ResolvedGovernanceRoot } from '#utils/workspace-root';
import type { ResolvedLiminaInputs } from './root-types';
import { normalizeConfig } from './runtime';

export function createDefaultInputs(
  governanceRoot: ResolvedGovernanceRoot,
): ResolvedLiminaInputs {
  return {
    ...normalizeConfig({}),
    governanceRoot,
    rootDir: governanceRoot.rootDir,
  };
}

/**
A real location for context diagnostics and module resolution, not load evidence.
*/
export function configContextPath(config: ResolvedLiminaInputs): string {
  return config.configPath ?? config.governanceRoot.manifestPath;
}
