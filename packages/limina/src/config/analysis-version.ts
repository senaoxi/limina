import { invocationDataVersion } from './invocation-data';
import type { ResolvedLiminaConfig } from './root-types';

function hasVirtualInputs(config: ResolvedLiminaConfig): boolean {
  return (config.virtualFiles?.size ?? 0) > 0;
}

/**
Version every effective user field, including future fields, as one contract.
Only generation-local inputs and namespace bindings have separate authorities.
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
  return hasVirtualInputs(config)
    ? undefined
    : invocationDataVersion(Object.defineProperties({}, properties));
}
