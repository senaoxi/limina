import { withoutAnalysisReads } from '#utils/analysis-input';
import type ts from 'typescript';
import { currentProfile } from '../../application/analysis/observability';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import type {
  AnalysisCacheMetrics,
  InputDependency,
  ResolutionRecord,
} from './contracts';
import { hasDeclarationReceipt } from './declaration-schema';
import { analysisHash } from './identity';
import type { AnalysisInputs } from './inputs';
import {
  type CacheOrigin,
  recordCacheHit,
  recordCacheMiss,
} from './profile-decisions';
import { QueryTrace } from './query-trace';

export interface ResolutionQueryBinding<T> {
  configPaths?: readonly string[];
  formatManifests?: readonly string[];
  host: ts.ModuleResolutionHost;
  resolve(host: ts.ModuleResolutionHost): T;
}

export type ResolutionQuery<T> = {
  contextId: string;
  file: string;
  identity: unknown;
  retain?: boolean;
  receipts?: Set<string>;
  owners?(target: string): string[] | undefined;
  configPaths?: readonly string[];
  observeSource?: boolean;
} & (ResolutionQueryBinding<T> | { prepare(): ResolutionQueryBinding<T> });
interface QueryOptions {
  inputs: AnalysisInputs;
  previous: Record<string, ResolutionRecord>;
  metrics: AnalysisCacheMetrics;
  dirty: ReadonlySet<string>;
  origin?: CacheOrigin;
  previousReceipt?(contextId: string, id: string): string | undefined;
}

type ResolutionRejection = string | { dependency: InputDependency };

function plainResolution(raw: unknown): { value: unknown; complete: boolean } {
  let isComplete = true;
  const encoded = JSON.stringify(raw, (key, value) => {
    if (key === 'file') isComplete = false;
    return key === 'file' ? undefined : value;
  });
  return { value: JSON.parse(encoded), complete: isComplete };
}

function resolutionOwners(
  raw: unknown,
  owners: NonNullable<ResolutionQuery<unknown>['owners']>,
): string[] | undefined {
  const result = raw as {
    resolvedModule?: { resolvedFileName: string };
    resolvedTypeReferenceDirective?: { resolvedFileName: string };
  };
  const target = result.resolvedModule ?? result.resolvedTypeReferenceDirective;
  return target?.resolvedFileName ? owners(target.resolvedFileName) : [];
}

export class ResolutionQueries {
  readonly #options: QueryOptions;
  readonly #byContext = new Map<string, Map<string, Set<string>>>();
  readonly records: Record<string, ResolutionRecord> = {};
  readonly retained: Set<string> = new Set<string>();
  constructor(options: QueryOptions) {
    this.#options = options;
  }

  #subscribe(contextId: string, file: string, id: string): void {
    const files =
      this.#byContext.get(contextId) ?? new Map<string, Set<string>>();
    const queries = files.get(file) ?? new Set<string>();
    queries.add(id);
    files.set(file, queries);
    this.#byContext.set(contextId, files);
  }

  #rejection<T>(
    record: ResolutionRecord,
    query: ResolutionQuery<T>,
  ): ResolutionRejection | undefined {
    if (record.coverage !== 'complete') return 'resolution-coverage-unknown';
    if (query.owners !== undefined) {
      const current = resolutionOwners(record.result, query.owners);
      if (
        !current ||
        JSON.stringify(current) !== JSON.stringify(record.targetOwners)
      )
        return 'resolution-target-ownership-changed';
    }
    const hasReceipt = hasResolutionReceipt(record);
    const dependency = record.dependencies.find(
      (input) => !this.#options.inputs.valid(input),
    );
    return hasReceipt
      ? dependency === undefined
        ? undefined
        : { dependency }
      : 'resolution-receipt-missing';
  }

  #restore<T>(id: string, record: ResolutionRecord): T {
    this.restore(id, record);
    return structuredClone(record.result) as T;
  }

  #resolve<T>(query: ResolutionQuery<T>, id: string): T {
    const trace = new QueryTrace(this.#options.inputs);
    const binding = 'prepare' in query ? query.prepare() : query;
    const configPaths = new Set([
      ...(query.configPaths ?? []),
      ...(binding.configPaths ?? []),
    ]);
    for (const path of configPaths) trace.add(path, 'config-mtime');
    const formatManifests = binding.formatManifests ?? [];
    for (const path of formatManifests) trace.add(path, 'manifest');
    if (query.observeSource) {
      trace.add(query.file, 'content');
      trace.add(query.file, 'binding');
    }
    this.#options.metrics.resolverCalls += 1;
    const resolve = () => {
      const host = trace.host(binding.host);
      const observer = currentProfile();
      if (observer === undefined) return binding.resolve(host);
      const scope = observer.currentScope;
      observer.metric('cache.native-resolution.resolve', scope, 'calls', 1);
      return observer.sumElapsed(
        'cache.native-resolution.resolve-elapsed-sum',
        scope,
        () => binding.resolve(host),
      );
    };
    const raw =
      query.receipts === undefined ? resolve() : withoutAnalysisReads(resolve);
    trace.raw(raw);
    const plain = plainResolution(raw);
    const targetOwners = query.owners && resolutionOwners(raw, query.owners);
    this.records[id] = {
      contextId: query.contextId,
      file: query.file,
      request: query.identity,
      result: plain.value,
      ...(query.owners && { targetOwners: targetOwners ?? null }),
      dependencies: trace.dependencies.values().toArray(),
      coverage: trace.complete && plain.complete ? 'complete' : 'unknown',
    };
    this.#options.inputs.consume(this.records[id].dependencies);
    return raw;
  }

  #priorRejection<T>(
    old: ResolutionRecord,
    query: ResolutionQuery<T>,
    id: string,
  ): ResolutionRejection | undefined {
    const rejection = this.#rejection(old, query);
    if (rejection !== undefined) return rejection;
    return query.receipts &&
      this.#options.previousReceipt?.(query.contextId, id) !==
        nativeFingerprint(old)
      ? 'resolution-context-receipt-mismatch'
      : undefined;
  }

  #previous<T>(query: ResolutionQuery<T>, id: string): T {
    const old = this.#options.previous[id];
    if (this.#options.dirty.has(id) || this.#options.inputs.toolchainChanged) {
      recordCacheMiss(
        'native-resolution',
        this.#options.dirty.has(id)
          ? 'resolution-invalidated'
          : 'toolchain-input-changed',
        { file: query.file, bypassed: old === undefined || undefined },
      );
      return this.#resolve(query, id);
    }
    if (old === undefined) {
      this.#recordRejected(query.file, 'resolution-record-absent');
      return this.#resolve(query, id);
    }
    const observer = currentProfile();
    let rejection: ResolutionRejection | undefined;
    if (observer === undefined) {
      rejection = this.#priorRejection(old, query, id);
    } else {
      const scope = observer.currentScope;
      observer.metric(
        'cache.native-resolution.prior-admission.calls',
        scope,
        'calls',
        1,
      );
      rejection = observer.sumElapsed(
        'cache.native-resolution.prior-admission.elapsed-sum',
        scope,
        () => this.#priorRejection(old, query, id),
      );
    }
    if (rejection !== undefined) {
      this.#recordRejected(query.file, rejection);
      return this.#resolve(query, id);
    }
    this.#options.metrics.queryHits += 1;
    recordCacheHit(
      'native-resolution',
      this.#options.origin ?? 'unknown',
      query.file,
    );
    return this.#restore<T>(id, old);
  }

  #recordRejected(file: string, rejection: ResolutionRejection): void {
    if (typeof rejection === 'string') {
      recordCacheMiss('native-resolution', rejection, {
        file,
        absent: rejection === 'resolution-record-absent' || undefined,
      });
      return;
    }
    const { inputId } = rejection.dependency;
    const inputs = this.#options.inputs;
    const input = inputs.records[inputId] ?? inputs.previous[inputId];
    recordCacheMiss('native-resolution', 'resolution-input-stale', {
      file,
      input:
        input === undefined
          ? undefined
          : { kind: input.kind, file: input.path },
    });
  }

  evict(id: string): void {
    const record = this.records[id];
    if (record !== undefined)
      this.#byContext.get(record.contextId)?.get(record.file)?.delete(id);
    delete this.records[id];
    this.retained.delete(id);
  }

  byFile(contextId: string): Map<string, Set<string>> {
    return this.#byContext.get(contextId) ?? new Map();
  }

  restore(id: string, record: ResolutionRecord): void {
    this.#subscribe(record.contextId, record.file, id);
    this.#options.inputs.consume(record.dependencies);
    this.records[id] = record;
  }

  query<T>(query: ResolutionQuery<T>): T {
    const id = analysisHash([query.contextId, query.file, query.identity]);
    query.receipts?.add(id);
    if (query.retain) this.retained.add(id);
    this.#subscribe(query.contextId, query.file, id);
    const current = this.records[id];
    if (
      current !== undefined &&
      this.#rejection(current, query) === undefined
    ) {
      recordCacheHit('native-resolution', 'invocation-memory', query.file);
      return this.#restore<T>(id, current);
    }
    return this.#previous(query, id);
  }
}

export function hasResolutionReceipt(record: ResolutionRecord): boolean {
  const request = record.request;
  return (
    !Array.isArray(request) ||
    request[0] === 'library' ||
    hasResultReceipt(record.result)
  );
}
function hasResultReceipt(raw: unknown): boolean {
  const result = raw as {
    resolvedModule?: { resolvedFileName: string };
    resolvedTypeReferenceDirective?: { resolvedFileName: string };
  };
  const target = result.resolvedModule ?? result.resolvedTypeReferenceDirective;
  return target === undefined || hasDeclarationReceipt(target);
}
