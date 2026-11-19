import type { VueProjectSemanticIdentity } from '#checkers';
import { createVueProjectSemanticIdentity } from '../../checker/vue-semantic-identity';
import { withVueDeclarationLoading } from '../vue-semantic/loading-identity';
import {
  createVueOutputIdentity,
  parseVueOutputConfig,
} from '../vue-semantic/output-identity';
import { encodeData } from './data-codec';
import type { EpochInputReplay } from './epoch-inputs';
import { analysisHash } from './identity';
import type { NativeAnalysisCache } from './native-cache';
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
import { isVueAnalysisSupported, vueModuleContextId } from './vue-identity';
import type { VueInputTrace } from './vue-inputs';
import { VueAnalysisMemo } from './vue-memo';
import { isCurrentVueRecord, VueRecordState } from './vue-record-state';
import { parseVueQuery } from './vue-schema';
import { observeVueTools } from './vue-toolchain-inputs';

function parseRecordedProject(record: VueContextRecord, generation: number) {
  return createVueProjectSemanticIdentity({
    ...record.project,
    configPath:
      record.project.outputProjection?.sourceConfigPath ??
      record.project.configPath,
    generation,
  });
}
function recordedIdentity(
  record: VueContextRecord,
  source: VueProjectSemanticIdentity,
): VueProjectSemanticIdentity | undefined {
  const { configPath, outputProjection } = record.project;
  let identity: VueProjectSemanticIdentity | undefined = source;
  if (outputProjection !== undefined) {
    const virtualFiles = new Map(Object.entries(outputProjection.configs));
    if (!virtualFiles.has(configPath)) return undefined;
    const parsed = parseVueOutputConfig(source, configPath, virtualFiles);
    if (parsed === undefined || parsed.errors.length > 0) return undefined;
    identity = createVueOutputIdentity(source, {
      configPath,
      options: parsed.options,
      fileNames: parsed.fileNames,
      projectReferences: parsed.projectReferences,
      virtualFiles,
    });
    if (identity === undefined) return undefined;
  }
  return record.project.declarationLoading === undefined
    ? identity
    : withVueDeclarationLoading(identity, record.project.declarationLoading);
}

export class VueAnalysisRecords {
  readonly #states = new Map<string, VueRecordState>();
  readonly #qualified = new Set<string>();
  readonly #expected = new Set<string>();
  readonly #invalidatedSources = new Set<string>();
  readonly #eligibility = new WeakMap<VueProjectSemanticIdentity, boolean>();
  readonly #identities = new Map<string, VueProjectSemanticIdentity>();
  readonly #executionIdentities = new WeakSet<VueProjectSemanticIdentity>();
  readonly #previousModuleContexts = new Map<string, VueContextRecord>();
  readonly #memo = new VueAnalysisMemo();
  #unsupported = false;
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

  #restore(
    identity: VueProjectSemanticIdentity,
    replay?: EpochInputReplay,
  ): VueContextRecord | undefined {
    if (this.cache.inputs.domainDirty) return undefined;
    const id = this.#memo.contextId(identity);
    const record = this.#qualified.has(id)
      ? this.records[id]
      : this.#validate(identity, id);
    this.#bindExecutionInputs(identity, record, replay);
    return record;
  }

  #bindExecutionInputs(
    identity: VueProjectSemanticIdentity,
    record: VueContextRecord | undefined,
    replay?: EpochInputReplay,
  ): void {
    if (record === undefined || this.#executionIdentities.has(identity)) return;
    bindVueExecutionInputs(
      identity,
      this.cache.inputs,
      record.dependencies,
      replay,
    );
    this.#executionIdentities.add(identity);
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
    replay?: EpochInputReplay,
  ): VueProjectSemanticIdentity | undefined {
    const record = this.#previous(id);
    if (record === undefined) return undefined;
    const parsed = parseRecordedProject(record, generation);
    const identity = recordedIdentity(record, parsed.identity);
    if (identity === undefined) return undefined;
    const valid = [parsed.diagnostics.length === 0, this.supports(identity)];
    return valid.every(Boolean)
      ? this.#bindIdentity(identity, id, generation, replay)
      : undefined;
  }

  #bindIdentity(
    identity: VueProjectSemanticIdentity,
    id: string,
    generation: number,
    replay?: EpochInputReplay,
  ): VueProjectSemanticIdentity | undefined {
    if (
      [
        this.#memo.contextId(identity) !== id,
        this.#restore(identity, replay) === undefined,
      ].some(Boolean)
    )
      return undefined;
    this.#identities.set(`${id}:${generation}`, identity);
    return identity;
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
    for (const [key, identity] of this.#identities) {
      if (sourceConfig(identity) !== configPath) continue;
      this.#identities.delete(key);
      this.#eligibility.delete(identity);
      this.#executionIdentities.delete(identity);
    }
    for (const [id, state] of this.#states) {
      if (sourceConfig(state.identity) !== configPath) continue;
      this.#states.delete(id);
      this.#expected.delete(id);
      this.#eligibility.delete(state.identity);
      this.#executionIdentities.delete(state.identity);
    }
    for (const [id, record] of Object.entries(this.records)) {
      if (recordSourceConfig(record) !== configPath) continue;
      delete this.records[id];
      this.#qualified.delete(id);
      this.#expected.delete(id);
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

  identity(
    id: string,
    generation: number,
    replay?: EpochInputReplay,
  ): VueProjectSemanticIdentity | undefined {
    if (this.cache.inputs.domainDirty) return undefined;
    const key = `${id}:${generation}`;
    return (
      this.#identities.get(key) ?? this.#parseIdentity(id, generation, replay)
    );
  }

  restore(id: string, replay?: EpochInputReplay, generation = 0): boolean {
    return this.identity(id, generation, replay) !== undefined;
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

function sourceConfig(identity: VueProjectSemanticIdentity): string {
  return identity.outputProjection?.sourceConfigPath ?? identity.configPath;
}

function recordSourceConfig(record: VueContextRecord): string {
  return (
    record.project.outputProjection?.sourceConfigPath ??
    record.project.configPath
  );
}
