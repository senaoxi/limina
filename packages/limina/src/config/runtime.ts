import { getResolvedCheckers, normalizeExtensions } from '#checkers';
import { validateLiminaConfig } from '#config/schema';
import type {
  AutoCheckerConfig,
  CheckerConfigMode,
  CheckerName,
  CheckerScope,
  ResolvedCheckerConfig,
} from './pipeline-checker-types';
import type { LiminaConfig } from './root-types';

function isSourceKnipConfig(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

export function isSourceKnipEnabled(
  config: Pick<LiminaConfig, 'source'>,
): boolean {
  const knip = config.source?.knip;
  return knip === true || isSourceKnipConfig(knip);
}

/**
@deprecated Auto discovery is always active in the flat checker model.
*/
export function isAutoCheckerConfigMode(
  _checkers: CheckerConfigMode | undefined,
): boolean {
  if (_checkers === undefined) return false;
  return false;
}

export function getAutoCheckerConfig(
  checkers: CheckerConfigMode | undefined,
): AutoCheckerConfig {
  return checkers?.auto ?? {};
}

export function getNamedCheckerConfigs(
  checkers: CheckerConfigMode | undefined,
): Partial<Record<CheckerName, CheckerScope>> {
  if (checkers === undefined) return {};
  const named = { ...checkers };
  delete named.auto;
  return named;
}

export { defineConfig } from './define';

function isResolvedConfig(config: LiminaConfig): boolean {
  return 'configPath' in config && 'rootDir' in config;
}

function toUserConfig(config: LiminaConfig): LiminaConfig {
  if (!isResolvedConfig(config)) return config;
  const internalFields = new Set([
    'configPath',
    'rootDir',
    'governanceRoot',
    'virtualFiles',
  ]);
  const userConfig = Object.fromEntries(
    Object.keys(config)
      .filter((key) => !internalFields.has(key))
      .map((key) => [key, (config as Record<string, unknown>)[key]]),
  );
  return userConfig as LiminaConfig;
}

export function getActiveCheckers(
  config: LiminaConfig,
): ResolvedCheckerConfig[] {
  validateLiminaConfig(toUserConfig(config));
  return getResolvedCheckers(config);
}

export function getActiveCheckerExtensions(config: LiminaConfig): string[] {
  return normalizeExtensions(
    getActiveCheckers(config).flatMap((checker) => checker.extensions),
  );
}

export function normalizeConfig(value: unknown): LiminaConfig {
  const config = value as LiminaConfig;
  validateLiminaConfig(config);
  return config;
}
