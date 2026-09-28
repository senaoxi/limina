import {
  type ResolvedGovernanceRoot,
  resolveGovernanceRoot,
} from '#utils/workspace-root';

const roots = new WeakMap<object, ResolvedGovernanceRoot>();

/** Fixtures write manifests before their first governance operation, like config loading. */
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
