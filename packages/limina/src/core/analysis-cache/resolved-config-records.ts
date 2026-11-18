import {
  type ResolvedConfigCodec,
  type ResolvedConfigIdentity,
  withResolvedConfigCache,
} from '#utils/resolved-config-cache';
import { AsyncLocalStorage } from 'node:async_hooks';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import type {
  AnalysisCacheMetrics,
  DiscoveryRecord,
  ResolvedConfigRecord,
} from './contracts';
import { EpochInputReplay, EpochInputs } from './epoch-inputs';
import { analysisHash } from './identity';

const missingContent = analysisHash(undefined);

function hasConfigReads<T>(
  records: DiscoveryRecord[],
  identity: ResolvedConfigIdentity,
  value: T,
  codec: ResolvedConfigCodec<T>,
): boolean {
  const files = new Set(
    records.flatMap(({ descriptor, path, version }) =>
      version !== missingContent &&
      descriptor.kind === 'config-text' &&
      descriptor.path === path
        ? [path]
        : [],
    ),
  );
  return (
    files.has(identity.configPath) &&
    (codec.requiredFiles?.(value) ?? []).every((file) => files.has(file))
  );
}

function fingerprint(
  record: Omit<ResolvedConfigRecord, 'fingerprint'>,
): string {
  return nativeFingerprint([
    record.configPath,
    record.context,
    record.discovery,
    record.payload,
  ]);
}

function optionalProjection<T>(convert: () => T): T | undefined {
  // Opaque adapter data can be unsupported or unreadable. TypeScript parsing
  // and physical input observation errors still propagate to the caller.
  try {
    return convert();
  } catch {
    return undefined;
  }
}

export class ResolvedConfigRecords {
  readonly #prior: Map<string, ResolvedConfigRecord>;
  readonly #rounds = new AsyncLocalStorage<EpochInputReplay>();
  readonly #metrics: AnalysisCacheMetrics;
  readonly records: Record<string, ResolvedConfigRecord> = {};

  constructor(
    prior: Record<string, ResolvedConfigRecord>,
    metrics: AnalysisCacheMetrics,
  ) {
    this.#prior = new Map(Object.entries(prior));
    this.#metrics = metrics;
  }

  #resolve<T>(
    identity: ResolvedConfigIdentity,
    parse: () => T,
    codec: ResolvedConfigCodec<T>,
    replay: EpochInputReplay,
  ): T {
    const key = analysisHash([identity.configPath, identity.context]);
    const prior = this.records[key] ?? this.#prior.get(key);
    if (prior !== undefined) {
      const restored = this.#restore(identity, prior, codec, replay);
      if (restored !== undefined) {
        this.records[key] = restored.record;
        this.#metrics.resolvedConfigHits++;
        return restored.value;
      }
      delete this.records[key];
      this.#prior.delete(key);
    }

    this.#metrics.resolvedConfigParses++;
    const reads = new EpochInputs();
    const result = reads.collect(parse);
    const discovery = reads.snapshot();
    if (
      discovery !== undefined &&
      hasConfigReads(discovery, identity, result, codec)
    ) {
      const payload = optionalProjection(() => codec.encode(result));
      if (payload !== undefined) {
        const record = { ...identity, discovery, payload };
        this.records[key] = { ...record, fingerprint: fingerprint(record) };
      }
    }
    return result;
  }

  #restore<T>(
    identity: ResolvedConfigIdentity,
    prior: ResolvedConfigRecord,
    codec: ResolvedConfigCodec<T>,
    replay: EpochInputReplay,
  ): { record: ResolvedConfigRecord; value: T } | undefined {
    if (
      prior.configPath !== identity.configPath ||
      prior.context !== identity.context ||
      fingerprint(prior) !== prior.fingerprint
    )
      return undefined;
    const reads = new EpochInputs();
    if (!reads.validateSynchronous(prior.discovery, replay)) return undefined;
    const value = optionalProjection(() => codec.decode(prior.payload));
    if (
      value === undefined ||
      !hasConfigReads(prior.discovery, identity, value, codec)
    )
      return undefined;
    reads.publish();
    const discovery = reads.refreshConfigStamps(prior.discovery);
    if (discovery === prior.discovery) return { record: prior, value };
    const record = { ...prior, discovery };
    return { record: { ...record, fingerprint: fingerprint(record) }, value };
  }

  // A graph hit can skip parser contexts used to build it. Carry their
  // candidates forward for live source configs; every later use revalidates.
  retainGraphSources(configPaths: readonly string[]): void {
    const sources = new Set(configPaths);
    for (const [key, candidate] of this.#prior)
      if (sources.has(candidate.configPath)) this.records[key] ??= candidate;
  }

  replay(): EpochInputReplay {
    return this.#rounds.getStore() ?? new EpochInputReplay();
  }

  run<T>(operation: () => T): T {
    if (this.#rounds.getStore() !== undefined) return operation();
    const replay = new EpochInputReplay();
    return this.#rounds.run(replay, () =>
      withResolvedConfigCache(
        (identity, parse, codec) =>
          this.#resolve(identity, parse, codec, replay),
        operation,
      ),
    );
  }
}
