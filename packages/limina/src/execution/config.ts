import type { ResolvedLiminaConfig } from '#config/runner';
import { availableParallelism } from 'node:os';

export type ExecutionConcurrency = number | 'auto';

export interface ExecutionConfig {
  checkerBuild?: ExecutionConcurrency;
  checkerTypecheck?: ExecutionConcurrency;
  failFast?: boolean;
  packageEntries?: ExecutionConcurrency;
  releaseEntries?: ExecutionConcurrency;
  tasks?: ExecutionConcurrency;
}

export interface ResolvedExecutionConfig {
  checkerBuild: ExecutionConcurrency;
  checkerTypecheck: ExecutionConcurrency;
  failFast: boolean;
  packageEntries: ExecutionConcurrency;
  releaseEntries: ExecutionConcurrency;
  tasks: ExecutionConcurrency;
}

export const defaultExecutionConfig: ResolvedExecutionConfig = {
  checkerBuild: 'auto',
  checkerTypecheck: 2,
  failFast: false,
  packageEntries: 'auto',
  releaseEntries: 2,
  tasks: 'auto',
} as const satisfies ResolvedExecutionConfig;

export interface ResolveExecutionConcurrencyOptions {
  availableParallelism?: () => number | undefined;
  config: ResolvedLiminaConfig;
  itemCount: number;
}

type ExecutionConcurrencyKind =
  | 'checkerBuild'
  | 'checkerTypecheck'
  | 'packageEntries'
  | 'releaseEntries'
  | 'tasks';

function getParallelism(
  parallelismProvider: (() => number | undefined) | undefined,
): number {
  return Math.max(1, parallelismProvider?.() ?? availableParallelism() ?? 4);
}

function clampConcurrency(value: number, itemCount: number): number {
  if (itemCount <= 0) {
    return 0;
  }

  return Math.min(itemCount, Math.max(1, Math.floor(value)));
}

function resolveExecutionConfig(
  config: ResolvedLiminaConfig,
): ResolvedExecutionConfig {
  return {
    checkerBuild:
      config.execution?.checkerBuild ?? defaultExecutionConfig.checkerBuild,
    checkerTypecheck:
      config.execution?.checkerTypecheck ??
      defaultExecutionConfig.checkerTypecheck,
    failFast: config.execution?.failFast ?? defaultExecutionConfig.failFast,
    packageEntries:
      config.execution?.packageEntries ?? defaultExecutionConfig.packageEntries,
    releaseEntries:
      config.execution?.releaseEntries ?? defaultExecutionConfig.releaseEntries,
    tasks: config.execution?.tasks ?? defaultExecutionConfig.tasks,
  };
}

function resolveAutoConcurrency(
  kind: ExecutionConcurrencyKind,
  options: ResolveExecutionConcurrencyOptions,
): number {
  const parallelism = getParallelism(options.availableParallelism);

  switch (kind) {
    case 'checkerBuild': {
      return clampConcurrency(parallelism, options.itemCount);
    }
    case 'checkerTypecheck': {
      return clampConcurrency(2, options.itemCount);
    }
    case 'packageEntries':
    case 'tasks': {
      return clampConcurrency(
        Math.max(2, Math.floor(parallelism / 2)),
        options.itemCount,
      );
    }
    case 'releaseEntries': {
      return clampConcurrency(2, options.itemCount);
    }
  }

  throw new Error(`Unsupported execution concurrency kind: ${kind}`);
}

function resolveConcurrency(
  kind: ExecutionConcurrencyKind,
  options: ResolveExecutionConcurrencyOptions,
): number {
  const value = resolveExecutionConfig(options.config)[kind];

  if (value === 'auto') {
    return resolveAutoConcurrency(kind, options);
  }

  return clampConcurrency(value, options.itemCount);
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
