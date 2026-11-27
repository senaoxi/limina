import type { ResolvedLiminaConfig } from '#config/runner';
import { performance } from 'node:perf_hooks';
import type { AnalysisMetricsRecorder } from '../application/analysis/analysis-run';
import { currentProfile } from '../application/analysis/observability';
import { effectiveConfigVersion } from '../config/analysis-version';
import {
  AnalysisInputDriftError,
  type AnalysisSnapshot,
} from '../core/analysis-cache/contracts';
import type { EpochInputs } from '../core/analysis-cache/epoch-inputs';
import { NativeAnalysisCache } from '../core/analysis-cache/native-cache';
import { cacheCause } from '../core/analysis-cache/profile-decisions';
import type { AnalysisBlockReadFilter } from '../core/analysis-cache/snapshot-shards';
import type { LiminaArtifactNamespace } from '../domain/artifacts/namespace';
import { analysisCacheIdentity } from './analysis-cache-identity';
import { AnalysisCacheStore } from './analysis-cache-store';
import { AnalysisToolObservation } from './analysis-cache-tools';
import { ConfigObservation } from './config-observation';
import { injectedAnalysisMetrics } from './profile-metrics';

export class AnalysisCacheController {
  readonly #store: AnalysisCacheStore;
  readonly #tools: AnalysisToolObservation;
  readonly #configuration: ConfigObservation;
  readonly #configPath: string;
  readonly #metrics: AnalysisMetricsRecorder | undefined;
  #analyzed = false;
  readonly #managedOutputs = new Map<string, EpochInputs>();
  readonly #canPublish: boolean;
  readonly #force: boolean;
  readonly #configVersion: string | undefined;
  readonly #completedMetrics: Record<string, number> = {};
  cache: NativeAnalysisCache;

  constructor(
    config: ResolvedLiminaConfig,
    namespace: LiminaArtifactNamespace,
    options: {
      blockReadFilter?: AnalysisBlockReadFilter;
      metrics?: AnalysisMetricsRecorder;
      canPublish?: boolean;
      force?: boolean;
    } = {},
  ) {
    const metrics = injectedAnalysisMetrics(options.metrics);
    const toolStart = metrics === undefined ? undefined : performance.now();
    this.#tools = new AnalysisToolObservation(config.configPath);
    if (toolStart !== undefined)
      metrics?.record({
        name: 'analysis-cache',
        kind: 'tool-identity',
        durationMs: performance.now() - toolStart,
      });
    this.#canPublish =
      options.canPublish !== false && options.blockReadFilter === undefined;
    this.#force = options.force === true;
    this.#configuration = new ConfigObservation(config);
    this.#configPath = config.configPath;
    this.#metrics = metrics;
    this.#configVersion = effectiveConfigVersion(config);
    this.#store = new AnalysisCacheStore({
      blockReadFilter: options.blockReadFilter,
      namespace,
      governanceRoot: config.rootDir,
      identity: analysisCacheIdentity(config, this.#tools.identity),
      configPath: config.configPath,
      configVersion: this.#configVersion,
      metrics: options.metrics,
      configuration: this.#configuration,
    });
    this.cache = this.#createCache();
  }

  #createCache(): NativeAnalysisCache {
    const cache = this.#cacheFromCandidate(
      this.#store.read({ restore: !this.#force }),
    );
    if (this.#configVersion === undefined)
      cache.fallback('configuration-version-unknown');
    return cache;
  }

  #cacheFromCandidate(
    candidate: AnalysisSnapshot | undefined,
    liveConfigTimes?: ReadonlyMap<string, number>,
  ) {
    const admission = this.#store.admissionDecision;
    const cache = new NativeAnalysisCache(this.#store.identity, candidate, {
      configVersion: this.#configVersion,
      configModules: this.#configuration.snapshot(),
      previousOrigin: this.#store.candidateOrigin,
      liveConfigTimes,
    });
    const profile = currentProfile();
    const basis = admission === undefined ? undefined : [admission];
    cache.snapshotDecision = profile?.decision(
      'analysis-snapshot',
      cache.previous === undefined
        ? {
            stage: 'adoption',
            outcome: 'not-adopted',
            causes: [
              candidate === undefined
                ? cacheCause(admission, 'no-snapshot-candidate')
                : { code: 'candidate-binding-rejected' },
            ],
          }
        : {
            stage: 'adoption',
            outcome: 'adopted',
            origin: cache.previousOrigin,
            basis,
          },
      profile.path(this.#configPath),
    );
    return cache;
  }

  async #attempt<T>(analyze: () => Promise<T>): Promise<T> {
    this.assertConfigurationStable();
    const epoch = this.cache;
    const result = await epoch.configReads.run(() => epoch.epoch.run(analyze));
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
    this.#reportCacheMetrics(metrics);
  }

  #reportCacheMetrics(metrics: AnalysisMetricsRecorder): void {
    const kinds = new Set([
      ...Object.keys(this.#completedMetrics),
      ...Object.keys(this.cache.metrics),
    ]);
    for (const kind of kinds) {
      recordCacheMetric(
        metrics,
        kind,
        this.#totalMetric(kind, this.cache.metrics[kind] ?? 0),
      );
    }
  }

  #totalMetric(kind: string, value: number): number {
    return value + (this.#completedMetrics[kind] ?? 0);
  }

  #completeMetrics(): void {
    for (const [kind, value] of Object.entries(this.cache.metrics))
      this.#completedMetrics[kind] = this.#totalMetric(kind, value);
  }
  #refreshedCache(reason?: 'producer-handoff'): NativeAnalysisCache {
    // A provider refresh may reuse validated in-memory data, but cannot renew
    // the physical publication baseline of a writer that already analyzed.
    const candidate = this.#analyzed
      ? this.#store.refresh(this.cache, reason)
      : this.#store.read({ restore: !this.#force });
    return this.#cacheFromCandidate(
      candidate,
      candidate !== undefined && candidate.header.baselineTime === undefined
        ? this.cache.inputs.configTimes()
        : undefined,
    );
  }
  #reportConfigMetrics(metrics: AnalysisMetricsRecorder): void {
    for (const [kind, value] of Object.entries(this.#configuration.metrics))
      recordCacheMetric(metrics, `config-modules-${kind}`, value);
  }

  async #validateManagedDrift(error: unknown): Promise<void> {
    if (
      !(error instanceof AnalysisInputDriftError) ||
      !this.#managedOutputs.has(error.inputPath)
    )
      throw error;
    // Discard this publication only. All other original reads must still
    // agree, and every authorized output must match its post-run receipt.
    const outputs = new Set(this.#managedOutputs.keys());
    await this.cache.epoch.assertStable(outputs);
    this.cache.inputs.assertStable(outputs);
    this.assertConfigurationStable();
    for (const receipt of this.#managedOutputs.values())
      await receipt.assertStable();
  }

  #recordSkippedPublication(code: string): void {
    const profile = currentProfile();
    profile?.decision(
      'analysis-snapshot',
      { stage: 'publication', outcome: 'not-published', causes: [{ code }] },
      profile.path(this.#configPath),
    );
  }

  refresh(reason?: 'producer-handoff'): void {
    this.assertConfigurationStable();
    if (this.#metrics !== undefined) this.#completeMetrics();
    this.cache = this.#refreshedCache(reason);
    this.#managedOutputs.clear();
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

  recordManagedOutput(path: string, observation: EpochInputs): void {
    this.#managedOutputs.set(path, observation);
  }

  /**
  Called after execution, outside retry; completed commands are never replayed.
  */
  async publish(): Promise<void> {
    this.assertConfigurationStable();
    if (!this.#analyzed) {
      this.#recordSkippedPublication('analysis-not-completed');
      return;
    }
    try {
      if (this.#canPublish) {
        await this.#store.publish(this.cache, async () => {
          this.assertConfigurationStable();
          await this.cache.epoch.assertStable();
        });
      } else {
        await this.cache.epoch.assertStable();
        this.cache.inputs.assertStable();
        this.#recordSkippedPublication('read-only');
      }
    } catch (error) {
      try {
        await this.#validateManagedDrift(error);
      } catch (error_) {
        if (error_ instanceof AnalysisInputDriftError)
          this.#recordSkippedPublication('analysis-input-drift');
        throw error_;
      }
      this.#recordSkippedPublication('managed-output-drift-discard');
    }
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
