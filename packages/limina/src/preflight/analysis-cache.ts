import type { ResolvedLiminaConfig } from '#config/runner';
import type { AnalysisMetricsRecorder } from '../application/analysis/analysis-run';
import { AnalysisInputDriftError } from '../core/analysis-cache/contracts';
import { NativeAnalysisCache } from '../core/analysis-cache/native-cache';
import type { LiminaArtifactNamespace } from '../domain/artifacts/namespace';
import {
  analysisCacheIdentity,
  assertGovernanceBinding,
  configInputs,
  readConfigInput,
} from './analysis-cache-identity';
import { AnalysisCacheStore } from './analysis-cache-store';

export class AnalysisCacheController {
  readonly #store: AnalysisCacheStore;
  readonly #config: ResolvedLiminaConfig;
  readonly #configInputs: Map<string, string | null>;
  readonly #metrics: AnalysisMetricsRecorder | undefined;
  #analyzed = false;
  readonly #completedMetrics: Record<string, number> = {};
  cache: NativeAnalysisCache;

  constructor(
    config: ResolvedLiminaConfig,
    namespace: LiminaArtifactNamespace,
    metrics?: AnalysisMetricsRecorder,
  ) {
    this.#config = config;
    assertGovernanceBinding(config);
    this.#configInputs = configInputs(config);
    this.#metrics = metrics;
    this.#store = new AnalysisCacheStore({
      namespace,
      identity: analysisCacheIdentity(config),
      configPath: config.configPath,
      metrics,
    });
    this.cache = this.#createCache();
  }

  #createCache(): NativeAnalysisCache {
    return new NativeAnalysisCache(this.#store.identity, this.#store.read());
  }

  async #attempt<T>(analyze: () => Promise<T>): Promise<T> {
    this.assertConfigurationStable();
    const epoch = this.cache;
    const result = await epoch.epoch.run(analyze);
    if (epoch !== this.cache)
      throw new Error('Analysis epoch was replaced before completion.');
    this.assertConfigurationStable();
    await this.cache.epoch.assertStable();
    this.cache.inputs.assertStable();
    this.#analyzed = true;
    return result;
  }

  #recordRetry(): void {
    this.#metrics?.record({
      name: 'analysis-cache',
      kind: 'epoch-retry',
      count: 1,
    });
  }

  #reportMetrics(): void {
    this.cache.metrics.uniquePaths = new Set(
      Object.values(this.cache.inputs.records).map((input) => input.path),
    ).size;
    this.cache.metrics.referenceEdges = this.cache.contributions.counts().size;
    this.cache.metrics.referenceOccurrences = Object.values(
      this.cache.contributions.records,
    ).flat().length;
    const metrics = this.#metrics;
    if (metrics === undefined) return;
    for (const [kind, value] of Object.entries(this.cache.metrics)) {
      recordCacheMetric(metrics, kind, this.#totalMetric(kind, value));
    }
  }

  #totalMetric(kind: string, value: number): number {
    return value + (this.#completedMetrics[kind] ?? 0);
  }

  refresh(): void {
    this.assertConfigurationStable();
    for (const [kind, value] of Object.entries(this.cache.metrics))
      this.#completedMetrics[kind] =
        (this.#completedMetrics[kind] ?? 0) + value;
    this.cache = this.#createCache();
    this.#analyzed = false;
  }

  assertConfigurationStable(): void {
    assertGovernanceBinding(this.#config);
    for (const [file, text] of this.#configInputs) {
      if (readConfigInput(file) === text) continue;
      throw new Error(
        `Limina configuration or governance root changed during execution: ${file}. Run the command again to load the new configuration.`,
      );
    }
  }

  async analyze<T>(operations: {
    analyze(): Promise<T>;
    refresh(): void;
  }): Promise<T> {
    try {
      return await this.#attempt(operations.analyze);
    } catch (error) {
      if (!(error instanceof AnalysisInputDriftError)) throw error;
      this.assertConfigurationStable();
      this.#recordRetry();
      operations.refresh();
      return this.#attempt(operations.analyze);
    }
  }

  /**
  Called after execution, outside retry; completed commands are never replayed.
  */
  async publish(): Promise<void> {
    this.assertConfigurationStable();
    if (!this.#analyzed) return;
    await this.cache.epoch.assertStable();
    this.cache.inputs.assertStable();
    await this.#store.publish(this.cache, async () => {
      this.assertConfigurationStable();
      await this.cache.epoch.assertStable();
    });
    this.#reportMetrics();
  }
}

function recordCacheMetric(
  metrics: AnalysisMetricsRecorder,
  kind: string,
  value: number,
): void {
  const measurement = kind.endsWith('Ms')
    ? { durationMs: value }
    : { count: value };
  metrics.record({ name: 'analysis-cache', kind, ...measurement });
}
