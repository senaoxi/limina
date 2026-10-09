import type {
  LiminaConfig,
  LiminaConfigExport,
  LiminaConfigFunction,
  LiminaConfigFunctionObject,
  LiminaConfigFunctionPromise,
} from './root-types';

export function defineConfig(config: LiminaConfig): LiminaConfig;
export function defineConfig(
  config: Promise<LiminaConfig>,
): Promise<LiminaConfig>;
export function defineConfig(
  config: LiminaConfigFunctionObject,
): LiminaConfigFunctionObject;
export function defineConfig(
  config: LiminaConfigFunctionPromise,
): LiminaConfigFunctionPromise;
export function defineConfig(
  config: LiminaConfigFunction,
): LiminaConfigFunction;
export function defineConfig(config: LiminaConfigExport): LiminaConfigExport {
  return config;
}
