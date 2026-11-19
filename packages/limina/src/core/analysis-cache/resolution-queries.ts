import { withoutAnalysisReads } from '#utils/analysis-input';
import type ts from 'typescript';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import type { AnalysisCacheMetrics, ResolutionRecord } from './contracts';
import { hasDeclarationReceipt } from './declaration-schema';
import { analysisHash } from './identity';
import type { AnalysisInputs } from './inputs';
import { QueryTrace } from './query-trace';

export interface ResolutionQuery<T> {
  contextId: string;
  file: string;
  identity: unknown;
  retain?: boolean;
  receipts?: Set<string>;
  owners?(target: string): string[] | undefined;
  configPaths?: readonly string[];
  host: ts.ModuleResolutionHost;
  resolve(host: ts.ModuleResolutionHost): T;
}
interface QueryOptions {
  inputs: AnalysisInputs;
  previous: Record<string, ResolutionRecord>;
  metrics: AnalysisCacheMetrics;
  dirty: ReadonlySet<string>;
  previousReceipt(contextId: string, id: string): string | undefined;
}

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

  #isValid<T>(
    record: ResolutionRecord | undefined,
    query: ResolutionQuery<T>,
  ): record is ResolutionRecord {
    if (record === undefined || record.coverage !== 'complete') return false;
    if (query.owners !== undefined) {
      const current = resolutionOwners(record.result, query.owners);
      if (
        !current ||
        JSON.stringify(current) !== JSON.stringify(record.targetOwners)
      )
        return false;
    }
    return this.#hasValidInputs(record);
  }

  #hasValidInputs(query: ResolutionRecord): boolean {
    const checks = [
      query.coverage === 'complete',
      hasResolutionReceipt(query),
      query.dependencies.every((input) => this.#options.inputs.valid(input)),
    ];
    return checks.every(Boolean);
  }

  #restore<T>(id: string, record: ResolutionRecord): T {
    this.restore(id, record);
    return structuredClone(record.result) as T;
  }

  #resolve<T>(query: ResolutionQuery<T>, id: string): T {
    const trace = new QueryTrace(this.#options.inputs);
    const configPaths = query.configPaths ?? [];
    for (const path of configPaths) trace.add(path, 'config-mtime');
    this.#options.metrics.resolverCalls += 1;
    const resolve = () => query.resolve(trace.host(query.host));
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

  #mustResolve(id: string): boolean {
    return this.#options.dirty.has(id) || this.#options.inputs.domainDirty;
  }

  #previous<T>(query: ResolutionQuery<T>, id: string): T {
    if (this.#mustResolve(id)) return this.#resolve(query, id);
    const old = this.#options.previous[id];
    if (!this.#isValid(old, query)) return this.#resolve(query, id);
    if (
      query.receipts &&
      this.#options.previousReceipt(query.contextId, id) !==
        nativeFingerprint(old)
    )
      return this.#resolve(query, id);
    this.#options.metrics.queryHits += 1;
    return this.#restore<T>(id, old);
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
    return this.#isValid(current, query)
      ? this.#restore<T>(id, current)
      : this.#previous(query, id);
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
