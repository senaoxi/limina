import { invocationDataVersion } from './invocation-data';
import type { ResolvedLiminaConfig } from './root-types';

const impacts = {
  scope: 'semantic',
  graph: 'semantic',
  source: 'semantic',
  proof: 'semantic',
  package: 'semantic',
  release: 'semantic',
  pipelines: 'semantic',
  concurrency: 'scheduling',
  cache: 'semantic',
  configPath: 'namespace',
  governanceRoot: 'namespace',
  rootDir: 'namespace',
  virtualFiles: 'generation',
} satisfies Record<
  keyof ResolvedLiminaConfig,
  'semantic' | 'scheduling' | 'namespace' | 'generation'
>;

function hasVirtualInputs(config: ResolvedLiminaConfig): boolean {
  return (config.virtualFiles?.size ?? 0) > 0;
}

/**
Version unknown fields conservatively. The exhaustive map forces each new typed
field to be classified; only proven scheduling data avoids semantic invalidation.
Configuration module observations independently qualify every new invocation.
*/
export function effectiveConfigVersion(
  config: ResolvedLiminaConfig,
): string | undefined {
  const properties: PropertyDescriptorMap =
    Object.getOwnPropertyDescriptors(config);
  delete properties.configPath;
  delete properties.governanceRoot;
  delete properties.rootDir;
  delete properties.virtualFiles;
  const data = Object.defineProperties({}, properties);
  if (invocationDataVersion(data) === undefined) return undefined;
  for (const [field, impact] of Object.entries(impacts))
    if (impact === 'scheduling') delete properties[field];
  return hasVirtualInputs(config)
    ? undefined
    : invocationDataVersion(Object.defineProperties({}, properties));
}
