import type { VueProjectSemanticIdentity } from '#checkers';
import { currentProfile } from '../../application/analysis/observability';
import { observeContextRestore } from '../analysis-profile';
import { vueProfileConfigPath } from '../vue-semantic/output-identity';
import type { NativeAnalysisCache } from './native-cache';
import { recordCacheHit, recordCacheMiss } from './profile-decisions';
import { QueryTrace } from './query-trace';
import type {
  VueContextRecord,
  VueQuery,
  VueQueryKind,
  VueQueryResults,
} from './vue-contracts';
import {
  bindVueExecutionInputs,
  retainVueExecutionInputs,
} from './vue-execution-inputs';
import {
  type VueGraphFactReader,
  VueGraphFacts,
  vueQueryKey,
} from './vue-graph-facts';
import { isVueAnalysisSupported, vueModuleContextId } from './vue-identity';
import type { VueInputTrace } from './vue-inputs';
import { VueAnalysisMemo } from './vue-memo';
import { vueRecordRejection, VueRecordState } from './vue-record-state';
import { parseVueQuery } from './vue-schema';
import { observeVueTools } from './vue-toolchain-inputs';

export class VueAnalysisRecords {
  readonly #states = new Map<string, VueRecordState>();
  readonly #qualified = new Set<string>();
  readonly #invalidatedSources = new Set<string>();
  readonly #eligibility = new WeakMap<VueProjectSemanticIdentity, boolean>();
  readonly #executionIdentities = new WeakSet<VueProjectSemanticIdentity>();
  readonly #previousModuleContexts = new Map<string, VueContextRecord>();
  readonly #graphFacts = new WeakMap<VueContextRecord, VueGraphFacts>();
  readonly #memo = new VueAnalysisMemo();
  readonly records: Record<string, VueContextRecord> = {};
  readonly cache: NativeAnalysisCache;
  constructor(cache: NativeAnalysisCache) {
    this.cache = cache;
    const previous = cache.previous?.vueContexts ?? {};
    for (const record of Object.values(previous))
      this.#previousModuleContexts.set(record.moduleContextId, record);
  }

  #qualify(identity: VueProjectSemanticIdentity): boolean {
    const isSupported = isVueAnalysisSupported(identity);
    this.#eligibility.set(identity, isSupported);
    if (!isSupported) {
      recordCacheMiss('vue-context', 'vue-unsupported-inputs', {
        file: sourceConfig(identity),
        bypassed: true,
      });
      return this.#reject('vue-unsupported-inputs');
    }
    observeVueTools(identity, new QueryTrace(this.cache.inputs));
    return true;
  }

  #reject(reason: string): false {
    this.cache.fallback(reason);
    return false;
  }

  #state(identity: VueProjectSemanticIdentity): VueRecordState {
    const id = this.#memo.contextId(identity);
    let state = this.#existingState(identity);
    if (state === undefined) {
      const restored = this.#restore(identity);
      const inputs = this.cache.inputs;
      const areConfigsCurrent = inputs.configCurrent(
        identity.configClosure.map(({ filePath }) => filePath),
      );
      const previous =
        areConfigsCurrent &&
        !this.#invalidatedSources.has(sourceConfig(identity))
          ? (this.#previous(id) ??
            this.#previousModuleContexts.get(vueModuleContextId(identity)))
          : undefined;
      state = new VueRecordState(identity, this.cache, restored, previous);
      this.#states.set(id, state);
    }
    return state;
  }

  #existingState(
    identity: VueProjectSemanticIdentity,
  ): VueRecordState | undefined {
    const state = this.#states.get(this.#memo.contextId(identity));
    if (state !== undefined) retainVueExecutionInputs(state.identity, identity);
    return state;
  }

  #previous(id: string): VueContextRecord | undefined {
    const record = this.cache.previous?.vueContexts[id];
    return (
      this.records[id] ??
      (record === undefined ||
      this.#invalidatedSources.has(recordSourceConfig(record))
        ? undefined
        : record)
    );
  }

  #restore(identity: VueProjectSemanticIdentity): VueContextRecord | undefined {
    if (this.cache.inputs.toolchainChanged)
      return this.#miss('toolchain-input-changed', sourceConfig(identity));
    const id = this.#memo.contextId(identity);
    const record = this.#qualified.has(id)
      ? this.records[id]
      : this.#validate(identity, id);
    this.#bindExecutionInputs(identity, record);
    return record;
  }

  #bindExecutionInputs(
    identity: VueProjectSemanticIdentity,
    record: VueContextRecord | undefined,
  ): void {
    if (record === undefined || this.#executionIdentities.has(identity)) return;
    bindVueExecutionInputs(identity, this.cache.inputs, record.dependencies);
    this.#executionIdentities.add(identity);
  }

  #validate(
    identity: VueProjectSemanticIdentity,
    id: string,
  ): VueContextRecord | undefined {
    const record = this.#previous(id);
    if (record === undefined)
      return this.#miss('vue-context-record-absent', sourceConfig(identity));
    const observer = currentProfile();
    if (observer === undefined) return this.#adopt(identity, id, record);
    return observeContextRestore(
      observer,
      'vue-context-restore',
      () => this.#adopt(identity, id, record),
      {
        configPath: vueProfileConfigPath(identity),
        checker: 'vue-tsc',
        provider: 'vue',
        role:
          identity.outputProjection === undefined
            ? (identity.declarationLoading?.purpose ?? 'source')
            : 'output-projection',
      },
    );
  }

  #adopt(
    identity: VueProjectSemanticIdentity,
    id: string,
    record: VueContextRecord,
  ): VueContextRecord | undefined {
    const rejection = vueRecordRejection(this.cache, identity, record);
    if (rejection !== undefined)
      return this.#miss(rejection, sourceConfig(identity));
    this.cache.inputs.consume(record.dependencies);
    this.cache.inputs.consumeNative();
    this.cache.increment('restoredVueContexts');
    recordCacheHit(
      'vue-context',
      this.records[id] === record
        ? 'invocation-memory'
        : this.cache.previousOrigin,
      sourceConfig(identity),
    );
    this.records[id] = record;
    this.#qualified.add(id);
    return record;
  }

  #miss(code: string, file: string): undefined {
    recordCacheMiss('vue-context', code, {
      file,
      absent: code === 'vue-context-record-absent' || undefined,
      basis: this.cache.snapshotDecision,
    });
  }

  #context(
    identity: VueProjectSemanticIdentity,
  ): VueRecordState | VueContextRecord | undefined {
    return this.#existingState(identity) ?? this.#restore(identity);
  }

  #read<K extends VueQueryKind>(
    query: VueQuery<K>,
    key: string,
  ): VueQueryResults[K] | undefined {
    if (this.cache.inputs.toolchainChanged) return undefined;
    const context = this.#context(query.identity);
    const record = context?.queries[key];
    const restored = this.#memo.decode(query.kind, record);
    if (restored === undefined) {
      recordCacheMiss(
        'vue-query',
        record === undefined
          ? 'vue-query-record-absent'
          : 'vue-query-payload-invalid',
        {
          file: sourceConfig(query.identity),
          absent: record === undefined || undefined,
        },
      );
    } else {
      const id = this.#memo.contextId(query.identity);
      const origin =
        this.cache.previous?.vueContexts[id]?.queries[key] === record
          ? this.cache.previousOrigin
          : 'invocation-memory';
      recordCacheHit('vue-query', origin, sourceConfig(query.identity));
    }
    return restored;
  }

  #collect<K extends VueQueryKind>(
    query: VueQuery<K>,
    key: string,
  ): VueQueryResults[K] | undefined {
    const state = this.#state(query.identity);
    const projected = this.cache.previous && query.fromModuleReceipt?.();
    this.cache.increment(
      projected === undefined ? 'vueQueries' : 'vueModuleBackedQueries',
    );
    const result = projected ?? query.collect();
    const parsed = parseVueQuery(query.kind, result);
    if (parsed === undefined) state.trace.complete = false;
    else state.captureQuery(key, query.kind, parsed);
    return result;
  }

  supports(identity: VueProjectSemanticIdentity | undefined): boolean {
    return identity === undefined
      ? this.#reject('vue-identity-missing')
      : (this.#eligibility.get(identity) ?? this.#qualify(identity));
  }

  reject(reason: string): void {
    this.#reject(reason);
  }

  invalidateSource(configPath: string): void {
    this.#invalidatedSources.add(configPath);
    for (const [id, state] of this.#states) {
      if (sourceConfig(state.identity) !== configPath) continue;
      this.#states.delete(id);
      this.#eligibility.delete(state.identity);
      this.#executionIdentities.delete(state.identity);
    }
    for (const [id, record] of Object.entries(this.records)) {
      if (recordSourceConfig(record) !== configPath) continue;
      delete this.records[id];
      this.#qualified.delete(id);
    }
  }

  trace(identity: VueProjectSemanticIdentity): VueInputTrace | undefined {
    return this.supports(identity) ? this.#state(identity).trace : undefined;
  }

  expect(identity: VueProjectSemanticIdentity | undefined): boolean {
    if (!this.supports(identity)) return false;
    if (this.#restore(identity!) === undefined) this.#state(identity!);
    return true;
  }

  graphFacts(
    identity: VueProjectSemanticIdentity,
    isOwnerActive: () => boolean = () => true,
  ): VueGraphFactReader | undefined {
    if (!this.cache.previous || !this.supports(identity)) return undefined;
    const id = this.#memo.contextId(identity);
    if (this.#states.has(id)) return undefined;
    const context = this.#restore(identity);
    if (context === undefined) return undefined;
    const facts =
      this.#graphFacts.get(context) ?? new VueGraphFacts(context, this.#memo);
    this.#graphFacts.set(context, facts);
    const observer = currentProfile();
    const scope =
      observer === undefined
        ? undefined
        : ([
            'project',
            observer.project(vueProfileConfigPath(identity)),
          ] as const);
    const isCurrent = () =>
      isOwnerActive() &&
      !this.cache.inputs.toolchainChanged &&
      this.records[id] === context &&
      !this.#states.has(id);
    return {
      occurrence: (record) => {
        const result = isCurrent() ? facts.read(record) : undefined;
        if (result !== undefined) {
          this.cache.increment('vueGraphOccurrenceProjections');
          observer?.metric(
            'graph.reference-facts.vue.occurrence-projections',
            scope!,
            'calls',
            1,
          );
        }
        return result;
      },
      source: (file) => (isCurrent() ? facts.source(file) : undefined),
      support: () => (isCurrent() ? facts.support(isCurrent) : undefined),
    };
  }

  query<K extends VueQueryKind>(
    query: VueQuery<K>,
  ): VueQueryResults[K] | undefined {
    if (!this.supports(query.identity)) return query.collect();
    const key = vueQueryKey(query.kind, query.request);
    const restored = this.#read(query, key);
    if (restored === undefined) return this.#collect(query, key);
    this.cache.increment('vueQueryHits');
    return restored;
  }

  capture(): void {
    this.#memo.assertStable();
    for (const [id, state] of this.#states) {
      this.records[id] = state.capture(this.cache.previous?.vueContexts[id]);
      this.cache.inputs.consume(this.records[id].dependencies);
    }
  }
}

function sourceConfig(identity: VueProjectSemanticIdentity): string {
  return identity.outputProjection?.sourceConfigPath ?? identity.configPath;
}

function recordSourceConfig(record: VueContextRecord): string {
  return record.project.sourceConfigPath ?? record.project.configPath;
}
