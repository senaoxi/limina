import type { ResolvedLiminaConfig } from '#config/runner';
import {
  type ResolvedGovernanceRoot,
  resolveGovernanceRoot,
} from '#utils/workspace-root';

const roots = new WeakMap<object, ResolvedGovernanceRoot>();

export function withFixtureGovernanceRoot(
  config: Omit<ResolvedLiminaConfig, 'governanceRoot'>,
): ResolvedLiminaConfig {
  return Object.defineProperty(config, 'governanceRoot', {
    configurable: true,
    enumerable: true,
    get(this: ResolvedLiminaConfig): ResolvedGovernanceRoot {
      return resolveFixtureGovernanceRoot(this);
    },
  }) as ResolvedLiminaConfig;
}

/**
Fixtures write manifests before their first governance operation, like config loading.
*/
export function resolveFixtureGovernanceRoot(config: {
  configPath: string;
}): ResolvedGovernanceRoot {
  let root = roots.get(config);
  if (root === undefined) {
    root = resolveGovernanceRoot(config.configPath);
    roots.set(config, root);
  }
  return root;
}
