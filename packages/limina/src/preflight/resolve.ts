import type { ResolvedLiminaConfig } from '#config/runner';
import { LiminaPreflightManager } from './manager';
import type { PreflightCapableOptions } from './types';

export function resolvePreflight(
  config: ResolvedLiminaConfig,
  options: PreflightCapableOptions = {},
): LiminaPreflightManager {
  return (
    options.preflight ??
    new LiminaPreflightManager({
      config,
      generatedGraphProvider: options.generatedGraphProvider,
      providers: options.providers,
    })
  );
}
