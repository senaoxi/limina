import type { ResolvedLiminaConfig } from '#config/runner';
import {
  type GovernanceCapabilityId,
  planCapabilitySubscriptions,
} from '../core/facts/subscription';
import { LiminaPreflightManager } from './manager';
import type { PreflightCapableOptions } from './types';

export function resolvePreflight(
  config: ResolvedLiminaConfig,
  options: PreflightCapableOptions = {},
  capability?: GovernanceCapabilityId,
): LiminaPreflightManager {
  return (
    options.preflight ??
    new LiminaPreflightManager({
      config,
      analysisCache: 'read-only',
      generatedGraphProvider: options.generatedGraphProvider,
      providers: options.providers,
      subscriptionPlan:
        capability === undefined || options.providers !== undefined
          ? undefined
          : planCapabilitySubscriptions([capability]),
    })
  );
}
