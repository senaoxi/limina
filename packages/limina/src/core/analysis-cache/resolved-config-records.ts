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
  readonly records: Record<string, ResolvedConfigRecord> = {};

  constructor(
    prior: Record<string, ResolvedConfigRecord>,
    metrics: AnalysisCacheMetrics,
    isConfigCurrent?: (paths: readonly string[]) => boolean,
  ) {
    this.#prior = new Map(Object.entries(prior));
    this.#metrics = metrics;
    this.#isConfigCurrent = isConfigCurrent;
  }

  #resolve<T>(
    identity: ResolvedConfigIdentity,
    closurePaths: readonly string[],
    parse: () => T,
    codec: ResolvedConfigCodec<T>,
    replay: EpochInputReplay,
  ): T {
    const key = analysisHash([identity.configPath, identity.context]);
    const prior = this.records[key] ?? this.#prior.get(key);
    if (prior !== undefined) {
      const restored = this.#restore(
        identity,
        closurePaths,
        prior,
        codec,
        replay,
      );
      if (restored !== undefined) {
        this.records[key] = restored.record;
        this.#metrics.resolvedConfigHits++;
        return restored.value;
      }
      delete this.records[key];
      this.#prior.delete(key);
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
  ): { record: ResolvedConfigRecord; value: T } | undefined {
    if (
      prior.configPath !== identity.configPath ||
      prior.context !== identity.context ||
      fingerprint(prior) !== prior.fingerprint
    )
      return undefined;
    const value = optionalProjection(() => codec.decode(prior.payload));
    if (value === undefined) return undefined;
    const requiredFiles = codec.requiredFiles?.(value);
    if (
      requiredFiles === undefined ||
      analysisHash(requiredFiles) !== analysisHash(closurePaths) ||
      !hasConfigReads(prior.discovery, identity, value, codec)
    )
      return undefined;
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
      return undefined;
    const reads = new EpochInputs();
    if (
      !reads.validateSynchronous(
        prior.discovery.filter((record) => !isClosureText(record)),
        replay,
      )
    )
      return undefined;
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
