import type { ResolvedLiminaConfig } from '#config/runner';
import { availableParallelism } from 'node:os';

export type ExecutionConcurrency = number | 'auto';

export interface ExecutionConfig {
  checkerBuild?: ExecutionConcurrency;
  checkerTypecheck?: ExecutionConcurrency;
  packageEntries?: ExecutionConcurrency;
  releaseEntries?: ExecutionConcurrency;
  tasks?: ExecutionConcurrency;
}

export interface ResolvedExecutionConfig {
  checkerBuild: ExecutionConcurrency;
  checkerTypecheck: ExecutionConcurrency;
  packageEntries: ExecutionConcurrency;
  releaseEntries: ExecutionConcurrency;
  tasks: ExecutionConcurrency;
}

export const defaultExecutionConfig: ResolvedExecutionConfig = {
  checkerBuild: 'auto',
  checkerTypecheck: 2,
  packageEntries: 'auto',
  releaseEntries: 2,
  tasks: 'auto',
} as const satisfies ResolvedExecutionConfig;

export interface ResolveExecutionConcurrencyOptions {
  availableParallelism?: () => number | undefined;
  config: ResolvedLiminaConfig;
  itemCount: number;
}

type ExecutionConcurrencyKind = keyof ResolvedExecutionConfig;

type AutoConcurrencyResolver = (
  parallelism: number,
  itemCount: number,
) => number;

function resolveAvailableParallelism(
  provider: (() => number | undefined) | undefined,
): number {
  const provided = provider?.();

  if (provided !== undefined) {
    return provided;
  }

  return availableParallelism();
}

function getParallelism(
  parallelismProvider: (() => number | undefined) | undefined,
): number {
  return Math.max(1, resolveAvailableParallelism(parallelismProvider));
}

function clampConcurrency(value: number, itemCount: number): number {
  if (itemCount <= 0) {
    return 0;
  }

  return Math.min(itemCount, Math.max(1, Math.floor(value)));
}

function configuredConcurrency(
  value: ExecutionConcurrency | undefined,
  fallback: ExecutionConcurrency,
): ExecutionConcurrency {
  return value === undefined ? fallback : value;
}

function getConfiguredConcurrency(
  config: ResolvedLiminaConfig,
  kind: ExecutionConcurrencyKind,
): ExecutionConcurrency {
  const configuredValue =
    config.execution === undefined ? undefined : config.execution[kind];

  return configuredConcurrency(configuredValue, defaultExecutionConfig[kind]);
}

function resolveExecutionConfig(
  config: ResolvedLiminaConfig,
): ResolvedExecutionConfig {
  return {
    checkerBuild: getConfiguredConcurrency(config, 'checkerBuild'),
    checkerTypecheck: getConfiguredConcurrency(config, 'checkerTypecheck'),
    packageEntries: getConfiguredConcurrency(config, 'packageEntries'),
    releaseEntries: getConfiguredConcurrency(config, 'releaseEntries'),
    tasks: getConfiguredConcurrency(config, 'tasks'),
  };
}

function resolveHalfParallelism(
  parallelism: number,
  itemCount: number,
): number {
  return clampConcurrency(Math.max(2, Math.floor(parallelism / 2)), itemCount);
}

function resolveFixedTwo(_parallelism: number, itemCount: number): number {
  return clampConcurrency(2, itemCount);
}

function resolveFullParallelism(
  parallelism: number,
  itemCount: number,
): number {
  return clampConcurrency(parallelism, itemCount);
}

const autoConcurrencyResolvers: Record<
  ExecutionConcurrencyKind,
  AutoConcurrencyResolver
> = {
  checkerBuild: resolveFullParallelism,
  checkerTypecheck: resolveFixedTwo,
  packageEntries: resolveHalfParallelism,
  releaseEntries: resolveFixedTwo,
  tasks: resolveHalfParallelism,
};

function resolveAutoConcurrency(
  kind: ExecutionConcurrencyKind,
  options: ResolveExecutionConcurrencyOptions,
): number {
  return autoConcurrencyResolvers[kind](
    getParallelism(options.availableParallelism),
    options.itemCount,
  );
}

function resolveConcurrency(
  kind: ExecutionConcurrencyKind,
  options: ResolveExecutionConcurrencyOptions,
): number {
  const value = resolveExecutionConfig(options.config)[kind];

  return value === 'auto'
    ? resolveAutoConcurrency(kind, options)
    : clampConcurrency(value, options.itemCount);
}

export function resolveTaskConcurrency(
  options: ResolveExecutionConcurrencyOptions,
): number {
  return resolveConcurrency('tasks', options);
}

export function resolveCheckerBuildConcurrency(
  options: ResolveExecutionConcurrencyOptions,
): number {
  return resolveConcurrency('checkerBuild', options);
}

export function resolveCheckerTypecheckConcurrency(
  options: ResolveExecutionConcurrencyOptions,
): number {
  return resolveConcurrency('checkerTypecheck', options);
}

export function resolvePackageEntryConcurrency(
  options: ResolveExecutionConcurrencyOptions,
): number {
  return resolveConcurrency('packageEntries', options);
}

export function resolveReleaseEntryConcurrency(
  options: ResolveExecutionConcurrencyOptions,
): number {
  return resolveConcurrency('releaseEntries', options);
}
