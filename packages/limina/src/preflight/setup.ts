import { type AnalysisProviderSet, createAnalysisProviders } from '#core';
import {
  type AnalysisMetricsRecorder,
  type AnalysisRun,
  createAnalysisRun,
  createNoopMetricsRecorder,
} from '../application/analysis/analysis-run';
import type { NativeAnalysisCache } from '../core/analysis-cache/native-cache';
import {
  createLiminaArtifactNamespace,
  type LiminaArtifactNamespace,
} from '../domain/artifacts/namespace';
import { identifier } from '../domain/shared/identifiers';
import { AnalysisCacheController } from './analysis-cache';
import { AnalysisToolObservation } from './analysis-cache-tools';
import { ConfigObservation } from './config-observation';
import type { LiminaPreflightManagerOptions } from './types';

export function resolveMetrics(
  options: LiminaPreflightManagerOptions,
): AnalysisMetricsRecorder {
  return options.metrics === undefined
    ? createNoopMetricsRecorder()
    : options.metrics;
}

export function resolveSignal(
  options: LiminaPreflightManagerOptions,
): AbortSignal {
  return options.signal === undefined
    ? new AbortController().signal
    : options.signal;
}

export function resolveArtifactNamespace(
  options: LiminaPreflightManagerOptions,
): LiminaArtifactNamespace {
  const providerNamespace = options.providers?.artifactNamespace;
  if (providerNamespace !== undefined) return providerNamespace;
  return createLiminaArtifactNamespace({
    generation: 0,
    rootDir: options.config.rootDir,
  });
}

export function resolveProviders(options: {
  analysisCache?: NativeAnalysisCache;
  artifactNamespace: LiminaArtifactNamespace;
  managerOptions: LiminaPreflightManagerOptions;
}): AnalysisProviderSet {
  return options.managerOptions.providers === undefined
    ? createAnalysisProviders(
        options.managerOptions.config,
        options.artifactNamespace,
        options.managerOptions.metrics,
        { analysisCache: options.analysisCache },
      )
    : options.managerOptions.providers;
}

export function createAnalysisCache(
  options: LiminaPreflightManagerOptions,
  namespace: LiminaArtifactNamespace,
): AnalysisCacheController | undefined {
  if (
    [options.providers !== undefined, options.config.cache === false].some(
      Boolean,
    )
  )
    return undefined;
  return options.analysisCache
    ? new AnalysisCacheController(options.config, namespace, {
        metrics: options.metrics,
        canPublish: options.analysisCache !== 'read-only',
        force: options.forceAnalysisCache,
      })
    : undefined;
}

export function observeUncachedConfig(
  options: LiminaPreflightManagerOptions,
  cache: AnalysisCacheController | undefined,
): ConfigObservation | undefined {
  if (cache !== undefined) return undefined;
  const observation = new ConfigObservation(options.config);
  observation.snapshot();
  return observation;
}

export function createPreflightRun(options: {
  generation: number;
  providerGeneration: number;
  rootDir: string;
  metrics: AnalysisMetricsRecorder;
  signal: AbortSignal;
}): AnalysisRun {
  return createAnalysisRun({
    generation: identifier<'AnalysisGeneration'>(String(options.generation)),
    metrics: options.metrics,
    signal: options.signal,
    snapshotToken: identifier<'RepositorySnapshotToken'>(
      `${options.rootDir}:${options.generation}:${options.providerGeneration}`,
    ),
  });
}

export function observeUncachedTools(
  options: LiminaPreflightManagerOptions,
  cache: AnalysisCacheController | undefined,
): AnalysisToolObservation | undefined {
  return cache === undefined
    ? new AnalysisToolObservation(options.config.configPath)
    : undefined;
}

export function managedRefreshOptions(
  options: LiminaPreflightManagerOptions,
  generation: number,
): LiminaPreflightManagerOptions {
  const namespace = createLiminaArtifactNamespace({
    generation,
    rootDir: options.config.rootDir,
  });
  return {
    ...options,
    providers: createAnalysisProviders(
      options.config,
      namespace,
      options.metrics,
    ),
  };
}

export function observeExecutionConfig(
  options: LiminaPreflightManagerOptions,
  cache: AnalysisCacheController | undefined,
): { assertStable(): void } {
  const config = observeUncachedConfig(options, cache);
  const tools = observeUncachedTools(options, cache);
  const checks = [
    () => cache?.assertConfigurationStable(),
    () => config?.assertStable(),
    () => tools?.assertStable(),
  ];
  return {
    assertStable() {
      for (const check of checks) check();
    },
  };
}
