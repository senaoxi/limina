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
import { pathBinding } from './directory-fingerprint';
import { EpochInputReplay, EpochInputs } from './epoch-inputs';
import { analysisHash } from './identity';
import {
  type CacheOrigin,
  recordCacheHit,
  recordCacheMiss,
} from './profile-decisions';

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
  readonly #isConfigCurrent?: (paths: readonly string[]) => boolean;
  readonly #origin: CacheOrigin;
  readonly records: Record<string, ResolvedConfigRecord> = {};

  constructor(
    prior: Record<string, ResolvedConfigRecord>,
    metrics: AnalysisCacheMetrics,
    isConfigCurrent?: (paths: readonly string[]) => boolean,
    origin: CacheOrigin = 'unknown',
  ) {
    this.#prior = new Map(Object.entries(prior));
    this.#metrics = metrics;
    this.#isConfigCurrent = isConfigCurrent;
    this.#origin = origin;
  }

  #resolve<T>(
    identity: ResolvedConfigIdentity,
    closurePaths: readonly string[],
    parse: () => T,
    codec: ResolvedConfigCodec<T>,
    replay: EpochInputReplay,
  ): T {
    const key = analysisHash([identity.configPath, identity.context]);
    const current = this.records[key];
    const prior = current ?? this.#prior.get(key);
    if (prior === undefined) {
      recordCacheMiss('resolved-config', 'resolved-config-record-absent', {
        file: identity.configPath,
        absent: true,
      });
    } else {
      const restored = this.#restore(
        identity,
        closurePaths,
        prior,
        codec,
        replay,
      );
      if (typeof restored !== 'string') {
        this.records[key] = restored.record;
        this.#metrics.resolvedConfigHits++;
        recordCacheHit(
          'resolved-config',
          current === undefined ? this.#origin : 'invocation-memory',
          identity.configPath,
        );
        return restored.value;
      }
      delete this.records[key];
      this.#prior.delete(key);
      recordCacheMiss('resolved-config', restored, {
        file: identity.configPath,
      });
    }

    const reads = new EpochInputs();
    const result = reads.collect(parse);
    const discovery = reads
      .snapshot()
      ?.filter((record) => record.descriptor.kind !== 'ts-directory');
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
    closurePaths: readonly string[],
    prior: ResolvedConfigRecord,
    codec: ResolvedConfigCodec<T>,
    replay: EpochInputReplay,
  ): string | { record: ResolvedConfigRecord; value: T } {
    if (
      prior.configPath !== identity.configPath ||
      prior.context !== identity.context ||
      fingerprint(prior) !== prior.fingerprint
    )
      return 'resolved-config-binding-invalid';
    const value = optionalProjection(() => codec.decode(prior.payload));
    if (value === undefined) return 'resolved-config-payload-invalid';
    const requiredFiles = codec.requiredFiles?.(value);
    if (
      requiredFiles === undefined ||
      analysisHash(requiredFiles) !== analysisHash(closurePaths) ||
      !hasConfigReads(prior.discovery, identity, value, codec)
    )
      return 'resolved-config-closure-changed';
    const closure = new Set(closurePaths);
    const isClosureText = (record: DiscoveryRecord) =>
      record.descriptor.kind === 'config-text' && closure.has(record.path);
    if (
      this.#isConfigCurrent?.(closurePaths) !== true ||
      prior.discovery
        .filter(isClosureText)
        .some(
          ({ path, binding }) => analysisHash(pathBinding(path)) !== binding,
        )
    )
      return 'resolved-config-mtime-or-binding-changed';
    const reads = new EpochInputs();
    if (
      !reads.validateSynchronous(
        prior.discovery.filter((record) => !isClosureText(record)),
        replay,
      )
    )
      return 'resolved-config-discovery-changed';
    reads.publish();
    return { record: prior, value };
  }

  replay(): EpochInputReplay {
    return this.#rounds.getStore() ?? new EpochInputReplay();
  }

  run<T>(operation: () => T): T {
    if (this.#rounds.getStore() !== undefined) return operation();
    const replay = new EpochInputReplay();
    const parsed = new Map<string, { value: unknown; reads: EpochInputs }>();
    return this.#rounds.run(replay, () =>
      withResolvedConfigCache(
        {
          resolve: (identity, closurePaths, parse, codec) =>
            this.#resolve(identity, closurePaths, parse, codec, replay),
          parse: <T>(operation: () => T, key: string | undefined): T => {
            const current = key === undefined ? undefined : parsed.get(key);
            if (current !== undefined) {
              current.reads.publish();
              recordCacheHit('resolved-config-live-parse', 'invocation-memory');
              return current.value as T;
            }
            this.#metrics.resolvedConfigParses++;
            if (key === undefined) return operation();
            const reads = new EpochInputs();
            const value = reads.collect(operation);
            parsed.set(key, { value, reads });
            return value;
          },
        },
        operation,
      ),
    );
  }
}
