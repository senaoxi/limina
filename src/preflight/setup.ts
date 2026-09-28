import { type AnalysisProviderSet, createAnalysisProviders } from '#core';
import {
  type AnalysisMetricsRecorder,
  createNoopMetricsRecorder,
} from '../application/analysis/analysis-run';
import {
  createLiminaArtifactNamespace,
  type LiminaArtifactNamespace,
} from '../domain/artifacts/namespace';
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
  artifactNamespace: LiminaArtifactNamespace;
  managerOptions: LiminaPreflightManagerOptions;
}): AnalysisProviderSet {
  if (options.managerOptions.providers !== undefined) {
    return options.managerOptions.providers;
  }

  return createAnalysisProviders(
    options.managerOptions.config,
    options.artifactNamespace,
    options.managerOptions.metrics,
  );
}
