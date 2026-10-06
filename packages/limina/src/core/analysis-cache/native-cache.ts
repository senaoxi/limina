import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import type { TypeScriptSemanticProject } from '../typescript-semantic/contracts';
import type { NativeDependencyFact } from '../typescript-semantic/dependency-fact';
import type {
  AnalysisCacheMetrics,
  AnalysisSnapshot,
  ImporterRecord,
  ResolutionRecord,
} from './contracts';
import { ANALYSIS_ADAPTER } from './contracts';
import { ReferenceContributions } from './contributions';
import { EpochInputs } from './epoch-inputs';
import { nativeContextId } from './identity';
import { type FactRequest, ImporterFacts } from './importer-facts';
import { AnalysisInputs } from './inputs';
import { AnalysisInvalidation } from './invalidation';
import { ResolutionQueries, type ResolutionQuery } from './resolution-queries';
import { SemanticState } from './semantic-state';

function emptyMetrics(): AnalysisCacheMetrics {
  return {
    probes: 0,
    probeMs: 0,
    reads: 0,
    readMs: 0,
    hashes: 0,
    hashMs: 0,
    resolverCalls: 0,
    queryHits: 0,
    factQueries: 0,
    factHits: 0,
    fallbacks: 0,
    importerHits: 0,
    importerQueries: 0,
    compilerReads: 0,
    compilerReadMs: 0,
    projectionMs: 0,
    semanticQueryMs: 0,
    firstSemanticQueryMs: 0,
  };
}

export class NativeAnalysisCache {
  readonly #resolutions: ResolutionQueries;
  readonly #facts: ImporterFacts;
  readonly #states = new Map<string, SemanticState>();
  readonly epoch: EpochInputs = new EpochInputs();
  readonly metrics: AnalysisCacheMetrics = emptyMetrics();
  readonly inputs: AnalysisInputs;
  readonly invalidation: AnalysisInvalidation;
  readonly queries: Record<string, ResolutionRecord>;
  readonly importers: Record<string, ImporterRecord>;
  readonly projects: AnalysisSnapshot['projects'] = {};
  readonly contributions: ReferenceContributions;

  readonly identity: string;
  readonly previous: AnalysisSnapshot | undefined;
  constructor(identity: string, previous?: AnalysisSnapshot) {
    this.identity = identity;
    this.previous = previous;
    const state = previous ?? emptySnapshot(identity);
    this.inputs = new AnalysisInputs(state.inputs, this.metrics);
    this.contributions = new ReferenceContributions(this.inputs);
    this.inputs.validatePrevious();
    this.invalidation = new AnalysisInvalidation(previous, this.inputs);
    this.#checkConsumerCoverage();
    this.#resolutions = new ResolutionQueries({
      inputs: this.inputs,
      metrics: this.metrics,
      previous: state.queries,
      dirty: this.invalidation.resolutionDirty,
    });
    this.#facts = new ImporterFacts({
      inputs: this.inputs,
      metrics: this.metrics,
      previous: state.importers,
      dirty: this.invalidation.semanticDirty,
    });
    this.queries = this.#resolutions.records;
    this.importers = this.#facts.records;
  }

  #checkConsumerCoverage(): void {
    if (this.previous === undefined) return;
    this.#checkCoverage(this.previous);
  }

  #checkCoverage(previous: AnalysisSnapshot): void {
    const isIncomplete = Object.values(previous.queries).some(
      (query) => query.coverage === 'unknown',
    );
    if (!isIncomplete) return;
    const fields = Object.values(previous.inputs).filter((input) =>
      ['imports', 'exports'].includes(input.kind),
    );
    const hasChanges = fields.some(
      (input) =>
        this.inputs.observe(input.path, input.kind).expectedVersion !==
        input.version,
    );
    this.inputs.domainDirty ||= hasChanges;
  }

  #physicalProject(project: TypeScriptSemanticProject): boolean {
    return (project.virtualFiles?.size ?? 0) === 0;
  }

  #currentImporters(): Record<string, ImporterRecord> {
    return Object.fromEntries(
      Object.entries(this.importers).filter(([, importer]) =>
        this.projects[importer.contextId]?.roots.includes(importer.filePath),
      ),
    );
  }

  #currentQueries(
    importers: Record<string, ImporterRecord>,
  ): Record<string, ResolutionRecord> {
    const used = new Set(
      Object.values(importers).flatMap((importer) => importer.queryIds),
    );
    return Object.fromEntries(
      Object.entries(this.queries).filter(([id]) => used.has(id)),
    );
  }

  supports(project: TypeScriptSemanticProject, tsModule: typeof ts): boolean {
    const isSupported = [
      tsModule === ts,
      tsModule.version === '6.0.3',
      this.#physicalProject(project),
      project.analysisBinding !== undefined,
    ].every(Boolean);
    if (!isSupported) this.fallback('unsupported-native-context');
    return isSupported;
  }

  fallback(reason: string): void {
    this.metrics.fallbacks += 1;
    const key = `fallback-${reason}`;
    this.metrics[key] = (this.metrics[key] ?? 0) + 1;
  }

  query<T>(query: ResolutionQuery<T>): T {
    return this.#resolutions.query(query);
  }

  prepare(
    project: TypeScriptSemanticProject,
    program: ts.Program,
    tsModule: typeof ts,
  ): void {
    const id = nativeContextId(project);
    const state = new SemanticState({
      project,
      program,
      tsModule,
      inputs: this.inputs,
      queries: this.queries,
      queriesByFile: this.#resolutions.byFile(id),
    });
    this.#states.set(id, state);
    this.#facts.prepare(id);
    this.projects[id] = state.projectRecord;
  }

  fact(request: FactRequest): NativeDependencyFact {
    return this.#facts.fact(
      request,
      this.#states.get(nativeContextId(request.project))!,
    );
  }

  snapshot(): AnalysisSnapshot {
    const importers = this.#currentImporters();
    const queries = this.#currentQueries(importers);
    const referenced = new Set([
      ...this.inputs.configInputs,
      ...Object.values(queries).flatMap((query) =>
        query.dependencies.map((dependency) => dependency.inputId),
      ),
    ]);
    for (const importer of Object.values(importers))
      for (const dependency of importer.dependencies)
        referenced.add(dependency.inputId);
    // Keep current member contents and manifest old contents for next epoch's
    // environment and two-field comparisons, without retaining historical inputs.
    const members = new Set(
      Object.values(this.projects).flatMap((project) => project.members),
    );
    const manifestPaths = new Set(
      [...referenced]
        .map((id) => this.inputs.records[id].path)
        .filter((file) => file.endsWith('/package.json')),
    );
    const inputs = Object.fromEntries(
      Object.entries(this.inputs.records).filter(
        ([id, input]) =>
          referenced.has(id) ||
          members.has(input.path) ||
          manifestPaths.has(input.path),
      ),
    );
    return structuredClone({
      header: {
        schema: 1,
        implementation: ANALYSIS_ADAPTER,
        identity: this.identity,
        revision: randomUUID(),
      },
      inputs,
      queries,
      importers,
      projects: this.projects,
      contributions: this.contributions.records,
    });
  }
}

function emptySnapshot(identity: string): AnalysisSnapshot {
  return {
    header: {
      schema: 1,
      implementation: ANALYSIS_ADAPTER,
      identity,
      revision: randomUUID(),
    },
    inputs: {},
    projects: {},
    queries: {},
    importers: {},
    contributions: {},
  };
}
