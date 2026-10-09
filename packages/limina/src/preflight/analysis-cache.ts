import type { ResolvedLiminaConfig } from '#config/runner';
import type { AnalysisMetricsRecorder } from '../application/analysis/analysis-run';
import { effectiveConfigVersion } from '../config/analysis-version';
import { AnalysisInputDriftError } from '../core/analysis-cache/contracts';
import { NativeAnalysisCache } from '../core/analysis-cache/native-cache';
import type { LiminaArtifactNamespace } from '../domain/artifacts/namespace';
import { analysisCacheIdentity } from './analysis-cache-identity';
import { AnalysisCacheStore } from './analysis-cache-store';
import { AnalysisToolObservation } from './analysis-cache-tools';
import { ConfigObservation } from './config-observation';

export class AnalysisCacheController {
  readonly #store: AnalysisCacheStore;
  readonly #tools: AnalysisToolObservation;
  readonly #configuration: ConfigObservation;
  readonly #metrics: AnalysisMetricsRecorder | undefined;
  #analyzed = false;
  readonly #canPublish: boolean;
  readonly #force: boolean;
  readonly #configVersion: string | undefined;
  readonly #completedMetrics: Record<string, number> = {};
  cache: NativeAnalysisCache;

  constructor(
    config: ResolvedLiminaConfig,
    namespace: LiminaArtifactNamespace,
    options: {
      metrics?: AnalysisMetricsRecorder;
      canPublish?: boolean;
      force?: boolean;
    } = {},
  ) {
    this.#tools = new AnalysisToolObservation(config.configPath);
    this.#canPublish = options.canPublish !== false;
    this.#force = options.force === true;
    const metrics = options.metrics;
    this.#configuration = new ConfigObservation(config);
    this.#metrics = metrics;
    this.#configVersion = effectiveConfigVersion(config);
    this.#store = new AnalysisCacheStore({
      namespace,
      identity: analysisCacheIdentity(config, this.#tools.identity),
      configPath: config.configPath,
      configVersion: this.#configVersion,
      metrics,
      configuration: this.#configuration,
    });
    this.cache = this.#createCache();
  }

  #createCache(): NativeAnalysisCache {
    const cache = new NativeAnalysisCache(
      this.#store.identity,
      this.#store.read({ restore: !this.#force }),
      {
        configVersion: this.#configVersion,
        configModules: this.#configuration.snapshot(),
      },
    );
    if (this.#configVersion === undefined)
      cache.fallback('configuration-version-unknown');
    return cache;
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
    const metrics = this.#metrics;
    if (metrics === undefined) return;
    this.#reportConfigMetrics(metrics);
    this.cache.metrics.uniquePaths = new Set(
      Object.values(this.cache.inputs.records).map((input) => input.path),
    ).size;
    this.cache.metrics.referenceEdges = this.cache.contributions.counts().size;
    this.cache.metrics.referenceOccurrences = Object.values(
      this.cache.contributions.records,
    ).flat().length;
    for (const [kind, value] of Object.entries(this.cache.metrics)) {
      recordCacheMetric(metrics, kind, this.#totalMetric(kind, value));
    }
  }

  #totalMetric(kind: string, value: number): number {
    return value + (this.#completedMetrics[kind] ?? 0);
  }

  #completeMetrics(): void {
    for (const [kind, value] of Object.entries(this.cache.metrics))
      this.#completedMetrics[kind] = this.#totalMetric(kind, value);
  }
  #refreshedCache(): NativeAnalysisCache {
    // A provider refresh may reuse validated in-memory data, but cannot renew
    // the physical publication baseline of a writer that already analyzed.
    const candidate = this.#analyzed
      ? this.cache.snapshot()
      : this.#store.read({ restore: !this.#force });
    return new NativeAnalysisCache(this.#store.identity, candidate, {
      configVersion: this.#configVersion,
      configModules: this.#configuration.snapshot(),
    });
  }
  #reportConfigMetrics(metrics: AnalysisMetricsRecorder): void {
    for (const [kind, value] of Object.entries(this.#configuration.metrics))
      recordCacheMetric(metrics, `config-modules-${kind}`, value);
  }

  refresh(): void {
    this.assertConfigurationStable();
    this.#completeMetrics();
    this.cache = this.#refreshedCache();
    this.#analyzed = false;
  }

  assertConfigurationStable(): void {
    this.#configuration.assertStable();
    this.#tools.assertStable();
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
    if (!this.#canPublish) {
      this.#reportMetrics();
      return;
    }
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
