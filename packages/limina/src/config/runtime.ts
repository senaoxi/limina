import { getResolvedCheckers, normalizeExtensions } from '#checkers';
import { validateLiminaConfig } from '#config/schema';
import type {
  AutoCheckerConfig,
  CheckerConfigMode,
  ResolvedCheckerConfig,
} from './pipeline-checker-types';
import type {
  LiminaConfig,
  LiminaConfigExport,
  LiminaConfigFn,
  LiminaConfigFnObject,
  LiminaConfigFnPromise,
} from './root-types';

function isSourceKnipConfig(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

export function isSourceKnipEnabled(
  config: Pick<LiminaConfig, 'source'>,
): boolean {
  const knip = config.source?.knip;
  if (knip === true) return true;
  return isSourceKnipConfig(knip);
}

export function isAutoCheckerConfigMode(
  checkers: CheckerConfigMode | undefined,
): checkers is AutoCheckerConfig {
  if (checkers === undefined) return false;
  return checkers.mode === 'auto';
}

export function defineConfig(config: LiminaConfig): LiminaConfig;
export function defineConfig(
  config: Promise<LiminaConfig>,
): Promise<LiminaConfig>;
export function defineConfig(
  config: LiminaConfigFnObject,
): LiminaConfigFnObject;
export function defineConfig(
  config: LiminaConfigFnPromise,
): LiminaConfigFnPromise;
export function defineConfig(config: LiminaConfigFn): LiminaConfigFn;
export function defineConfig(config: LiminaConfigExport): LiminaConfigExport {
  return config;
}

function isResolvedConfig(config: LiminaConfig): boolean {
  if (!('configPath' in config)) return false;
  return 'rootDir' in config;
}

function toUserConfig(config: LiminaConfig): LiminaConfig {
  if (!isResolvedConfig(config)) return config;
  const userConfig: Record<string, unknown> = { ...config };
  delete userConfig.configPath;
  delete userConfig.rootDir;
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
