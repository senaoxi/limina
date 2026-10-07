import type ts from 'typescript';
import type { AnalysisCacheMetrics, ResolutionRecord } from './contracts';
import { analysisHash } from './identity';
import type { AnalysisInputs } from './inputs';
import { QueryTrace } from './query-trace';

export interface ResolutionQuery<T> {
  contextId: string;
  file: string;
  identity: unknown;
  host: ts.ModuleResolutionHost;
  resolve(host: ts.ModuleResolutionHost): T;
}
interface QueryOptions {
  inputs: AnalysisInputs;
  previous: Record<string, ResolutionRecord>;
  metrics: AnalysisCacheMetrics;
  dirty: ReadonlySet<string>;
}

function plainResolution(raw: unknown): { value: unknown; complete: boolean } {
  let isComplete = true;
  const encoded = JSON.stringify(raw, (key, value) => {
    if (key === 'file') isComplete = false;
    return key === 'file' ? undefined : value;
  });
  return { value: JSON.parse(encoded), complete: isComplete };
}

export class ResolutionQueries {
  readonly #options: QueryOptions;
  readonly #byContext = new Map<string, Map<string, Set<string>>>();
  readonly records: Record<string, ResolutionRecord> = {};
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

  #isValid(query: ResolutionRecord | undefined): query is ResolutionRecord {
    return query !== undefined && this.#hasValidInputs(query);
  }

  #hasValidInputs(query: ResolutionRecord): boolean {
    const checks = [
      query.coverage === 'complete',
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
    this.#options.metrics.resolverCalls += 1;
    const raw = query.resolve(trace.host(query.host));
    trace.raw(raw);
    const plain = plainResolution(raw);
    this.records[id] = {
      contextId: query.contextId,
      file: query.file,
      request: query.identity,
      result: plain.value,
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
    if (!this.#isValid(old)) return this.#resolve(query, id);
    this.#options.metrics.queryHits += 1;
    return this.#restore<T>(id, old);
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
    this.#subscribe(query.contextId, query.file, id);
    const current = this.records[id];
    return this.#isValid(current)
      ? this.#restore<T>(id, current)
      : this.#previous(query, id);
  }
}
