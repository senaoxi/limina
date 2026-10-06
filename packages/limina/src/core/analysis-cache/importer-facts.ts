import { performance } from 'node:perf_hooks';
import type { ImportRecord } from '../import-analysis/records';
import type {
  TypeScriptSemanticProject,
  TypeScriptSemanticResolution,
} from '../typescript-semantic/contracts';
import type { NativeDependencyFact } from '../typescript-semantic/dependency-fact';
import type { AnalysisCacheMetrics, ImporterRecord } from './contracts';
import { analysisHash, nativeContextId } from './identity';
import type { AnalysisInputs } from './inputs';
import type { SemanticState } from './semantic-state';
import { occurrenceKey } from './semantic-state';

export interface FactRequest {
  project: TypeScriptSemanticProject;
  record: ImportRecord;
  occurrences: readonly ImportRecord[];
  resolution: TypeScriptSemanticResolution;
  collect(): NativeDependencyFact;
}
interface FactContext {
  importer: ImporterRecord;
  previous: ImporterRecord | undefined;
}
interface FactCacheOptions {
  inputs: AnalysisInputs;
  metrics: AnalysisCacheMetrics;
  previous: Record<string, ImporterRecord>;
  dirty: ReadonlySet<string>;
}

function resolutionContract(value: TypeScriptSemanticResolution): unknown {
  const target =
    value.target === null
      ? null
      : [
          value.target.resolvedFileName,
          value.target.resolvedBy,
          value.target.isExternalLibraryImport,
        ];
  return [
    value.channel,
    value.resolutionMode,
    value.redirectedReferenceIdentity,
    target,
  ];
}

function hasSameResolution(
  fact: NativeDependencyFact | undefined,
  current: TypeScriptSemanticResolution,
): fact is NativeDependencyFact {
  return (
    fact !== undefined &&
    analysisHash(resolutionContract(fact.resolution)) ===
      analysisHash(resolutionContract(current))
  );
}

function bind(
  fact: NativeDependencyFact,
  resolution: TypeScriptSemanticResolution,
): NativeDependencyFact {
  return { ...structuredClone(fact), resolution: structuredClone(resolution) };
}

export class ImporterFacts {
  readonly #options: FactCacheOptions;
  readonly #queried = new Set<string>();
  readonly #firstQuery = new Set<string>();
  readonly #hit = new Set<string>();
  readonly #contexts = new Map<string, FactContext>();
  readonly records: Record<string, ImporterRecord> = {};

  constructor(options: FactCacheOptions) {
    this.#options = options;
  }

  #create(request: FactRequest, state: SemanticState): ImporterRecord {
    const dependencies = state.dependencies(request.record.filePath);
    return {
      contextId: nativeContextId(request.project),
      filePath: request.record.filePath,
      sourceVersion: this.#options.inputs.observe(
        request.record.filePath,
        'content',
      ).expectedVersion,
      environmentVersion: state.environmentVersion,
      membershipVersion: dependencies.membershipVersion,
      dependencies: dependencies.dependencies,
      queryIds: dependencies.queryIds,
      occurrences: structuredClone([...request.occurrences]),
      facts: {},
      coverage: dependencies.complete ? 'complete' : 'unknown',
    };
  }

  #canReuse(old: ImporterRecord, current: ImporterRecord): boolean {
    const checks: [string, boolean][] = [
      [
        'coverage',
        old.coverage === 'complete' && current.coverage === 'complete',
      ],
      ['manifest-domain', !this.#options.inputs.domainDirty],
      ['source', old.sourceVersion === current.sourceVersion],
      ['environment', old.environmentVersion === current.environmentVersion],
      ['membership', old.membershipVersion === current.membershipVersion],
      [
        'dependency',
        old.dependencies.every((dependency) =>
          this.#options.inputs.valid(dependency),
        ),
      ],
      [
        'query',
        !this.#options.dirty.has(
          analysisHash([current.contextId, current.filePath]),
        ),
      ],
    ];
    const failed = checks.find(([, valid]) => !valid);
    if (failed === undefined) return true;
    this.#count(`miss-${failed[0]}`);
    return false;
  }

  #count(reason: string): void {
    this.#options.metrics[reason] = (this.#options.metrics[reason] ?? 0) + 1;
  }

  #recordImporter(request: FactRequest, isHit: boolean): void {
    const group = isHit ? this.#hit : this.#queried;
    group.add(
      analysisHash([nativeContextId(request.project), request.record.filePath]),
    );
    this.#options.metrics[isHit ? 'importerHits' : 'importerQueries'] =
      group.size;
  }

  #context(request: FactRequest, state: SemanticState): FactContext {
    const id = analysisHash([
      nativeContextId(request.project),
      request.record.filePath,
    ]);
    const existing = this.#contexts.get(id);
    if (existing !== undefined) return existing;
    const importer = this.#create(request, state);
    const old = this.records[id] ?? this.#options.previous[id];
    const previous = this.#selectPrevious(old, importer);
    this.#options.inputs.consumeNative();
    this.records[id] = importer;
    const context = { importer, previous };
    this.#contexts.set(id, context);
    this.#options.inputs.consume([
      ...importer.dependencies,
      ...state.environmentDependencies,
    ]);
    return context;
  }

  #selectPrevious(
    old: ImporterRecord | undefined,
    current: ImporterRecord,
  ): ImporterRecord | undefined {
    if (old === undefined) {
      this.#count('miss-new-importer');
      return undefined;
    }
    return this.#canReuse(old, current) ? old : undefined;
  }

  #collect(
    cached: NativeDependencyFact | undefined,
    request: FactRequest,
  ): NativeDependencyFact {
    if (hasSameResolution(cached, request.resolution)) {
      this.#recordImporter(request, true);
      this.#options.metrics.factHits += 1;
      return bind(cached, request.resolution);
    }
    this.#recordImporter(request, false);
    this.#options.metrics.factQueries += 1;
    return this.#measureQuery(request);
  }

  #measureQuery(request: FactRequest): NativeDependencyFact {
    const startedAt = performance.now();
    try {
      return request.collect();
    } finally {
      const elapsed = performance.now() - startedAt;
      this.#options.metrics.semanticQueryMs += elapsed;
      this.#recordFirstQuery(nativeContextId(request.project), elapsed);
    }
  }

  #recordFirstQuery(contextId: string, elapsed: number): void {
    if (this.#firstQuery.has(contextId)) return;
    this.#firstQuery.add(contextId);
    this.#options.metrics.firstSemanticQueryMs += elapsed;
  }

  prepare(contextId: string): void {
    this.#firstQuery.delete(contextId);
    for (const [id, context] of this.#contexts) {
      if (context.importer.contextId === contextId) this.#contexts.delete(id);
    }
  }

  fact(request: FactRequest, state: SemanticState): NativeDependencyFact {
    const context = this.#context(request, state);
    const key = occurrenceKey(request.record);
    const current = context.importer.facts[key];
    if (current !== undefined) return bind(current, request.resolution);
    const cached = context.previous?.facts[key];
    const fact = this.#collect(cached, request);
    context.importer.facts[key] = structuredClone(fact);
    return fact;
  }
}
