import type { VueProjectSemanticIdentity } from '#checkers';
import { createVueProjectSemanticIdentity } from '../../checker/vue-semantic-identity';
import { encodeData } from './data-codec';
import { analysisHash } from './identity';
import type { NativeAnalysisCache } from './native-cache';
import { QueryTrace } from './query-trace';
import type {
  VueContextRecord,
  VueQuery,
  VueQueryKind,
  VueQueryResults,
} from './vue-contracts';
import { isVueAnalysisSupported } from './vue-identity';
import type { VueInputTrace } from './vue-inputs';
import { VueAnalysisMemo } from './vue-memo';
import { isCurrentVueRecord, VueRecordState } from './vue-record-state';
import { parseVueQuery } from './vue-schema';
import { observeVueTools } from './vue-toolchain-inputs';

export class VueAnalysisRecords {
  readonly #states = new Map<string, VueRecordState>();
  readonly #qualified = new Set<string>();
  readonly #expected = new Set<string>();
  readonly #eligibility = new WeakMap<VueProjectSemanticIdentity, boolean>();
  readonly #identities = new Map<string, VueProjectSemanticIdentity>();
  readonly #memo = new VueAnalysisMemo();
  #unsupported = false;
  readonly records: Record<string, VueContextRecord> = {};
  readonly cache: NativeAnalysisCache;
  constructor(cache: NativeAnalysisCache) {
    this.cache = cache;
  }

  #qualify(identity: VueProjectSemanticIdentity): boolean {
    const isSupported = isVueAnalysisSupported(identity);
    this.#eligibility.set(identity, isSupported);
    if (!isSupported) return this.#reject('vue-unsupported-inputs');
    observeVueTools(identity, new QueryTrace(this.cache.inputs));
    this.#expected.add(this.#memo.contextId(identity));
    return true;
  }

  #reject(reason: string): false {
    this.#unsupported = true;
    this.cache.fallback(reason);
    return false;
  }

  #state(identity: VueProjectSemanticIdentity): VueRecordState {
    const id = this.#memo.contextId(identity);
    let state = this.#states.get(id);
    if (state === undefined) {
      state = new VueRecordState(identity, this.cache, this.#restore(identity));
      this.#states.set(id, state);
    }
    return state;
  }

  #previous(id: string): VueContextRecord | undefined {
    return this.records[id] ?? this.cache.previous?.vueContexts[id];
  }

  #restore(identity: VueProjectSemanticIdentity): VueContextRecord | undefined {
    if (this.cache.inputs.domainDirty) return undefined;
    const id = this.#memo.contextId(identity);
    return this.#qualified.has(id)
      ? this.records[id]
      : this.#validate(identity, id);
  }

  #validate(
    identity: VueProjectSemanticIdentity,
    id: string,
  ): VueContextRecord | undefined {
    const record = this.#previous(id);
    if (
      record === undefined ||
      !isCurrentVueRecord(this.cache, identity, record)
    )
      return undefined;
    this.cache.inputs.consume(record.dependencies);
    this.cache.inputs.consumeNative();
    this.cache.increment('restoredVueContexts');
    this.records[id] = record;
    this.#qualified.add(id);
    return record;
  }

  #parseIdentity(
    id: string,
    generation: number,
  ): VueProjectSemanticIdentity | undefined {
    const record = this.#previous(id);
    if (record === undefined) return undefined;
    const parsed = createVueProjectSemanticIdentity({
      ...record.project,
      generation,
    });
    const valid = [
      parsed.diagnostics.length === 0,
      this.supports(parsed.identity),
    ];
    return valid.every(Boolean)
      ? this.#bindIdentity(parsed.identity, id, generation)
      : undefined;
  }

  #bindIdentity(
    identity: VueProjectSemanticIdentity,
    id: string,
    generation: number,
  ): VueProjectSemanticIdentity | undefined {
    if (
      [
        this.#memo.contextId(identity) !== id,
        this.#restore(identity) === undefined,
      ].some(Boolean)
    )
      return undefined;
    this.#identities.set(`${id}:${generation}`, identity);
    return identity;
  }

  #context(
    identity: VueProjectSemanticIdentity,
  ): VueRecordState | VueContextRecord | undefined {
    return (
      this.#states.get(this.#memo.contextId(identity)) ??
      this.#restore(identity)
    );
  }

  #read<K extends VueQueryKind>(
    query: VueQuery<K>,
    key: string,
  ): VueQueryResults[K] | undefined {
    if (this.cache.inputs.domainDirty) return undefined;
    const context = this.#context(query.identity);
    return context === undefined
      ? undefined
      : this.#memo.decode(query.kind, context.queries[key]);
  }

  #collect<K extends VueQueryKind>(
    query: VueQuery<K>,
    key: string,
  ): VueQueryResults[K] | undefined {
    const state = this.#state(query.identity);
    this.cache.increment('vueQueries');
    const result = query.collect();
    const parsed = parseVueQuery(query.kind, result);
    if (parsed === undefined) state.trace.complete = false;
    else state.queries[key] = { kind: query.kind, data: encodeData(parsed) };
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

  trace(identity: VueProjectSemanticIdentity): VueInputTrace | undefined {
    return this.supports(identity) ? this.#state(identity).trace : undefined;
  }

  expect(identity: VueProjectSemanticIdentity | undefined): boolean {
    if (!this.supports(identity)) return false;
    if (this.#restore(identity!) === undefined) this.#state(identity!);
    return true;
  }

  identity(
    id: string,
    generation: number,
  ): VueProjectSemanticIdentity | undefined {
    if (this.cache.inputs.domainDirty) return undefined;
    const key = `${id}:${generation}`;
    return this.#identities.get(key) ?? this.#parseIdentity(id, generation);
  }

  restore(id: string): boolean {
    return this.identity(id, 0) !== undefined;
  }

  query<K extends VueQueryKind>(
    query: VueQuery<K>,
  ): VueQueryResults[K] | undefined {
    if (!this.supports(query.identity)) return query.collect();
    const key = analysisHash(encodeData([query.kind, query.request]));
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

  complete(): boolean {
    return (
      !this.#unsupported &&
      [...this.#expected].every((id) => this.records[id]?.complete)
    );
  }
}
