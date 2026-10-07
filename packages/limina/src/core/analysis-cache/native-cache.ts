import ts from 'typescript';
import type {
  TypeScriptSemanticDependencyContext,
  TypeScriptSemanticProject,
} from '../typescript-semantic/contracts';
import type { NativeDependencyFact } from '../typescript-semantic/dependency-fact';
import { emptyMetrics } from './cache-metrics';
import { NativeContextRecords } from './context-records';
import type {
  AnalysisCacheMetrics,
  AnalysisSnapshot,
  GraphRecord,
  ImporterRecord,
  InputDependency,
  NativeContextRecord,
  ProjectRecord,
  ResolutionRecord,
} from './contracts';
import { ReferenceContributions } from './contributions';
import { EpochInputs } from './epoch-inputs';
import { CachedGraphRecords } from './graph-records';
import { nativeContextId } from './identity';
import { type FactRequest, ImporterFacts } from './importer-facts';
import { AnalysisInputs } from './inputs';
import { AnalysisInvalidation } from './invalidation';
import { ResolutionQueries, type ResolutionQuery } from './resolution-queries';
import { SemanticState } from './semantic-state';
import {
  areSameRecords,
  currentSnapshotRecords,
  emptySnapshot,
  matchingConfigSnapshot,
  newSnapshot,
  retainData,
} from './snapshot-records';

export class NativeAnalysisCache {
  readonly #resolutions: ResolutionQueries;
  readonly #facts: ImporterFacts;
  readonly #contexts: NativeContextRecords;
  readonly #graphs: CachedGraphRecords;
  #resolving = 0;
  readonly #executableContexts = new Set<string>();
  #hasUnsupportedContext = false;
  readonly #captures = new Map<
    string,
    { program: ts.Program; capture(): void }
  >();
  readonly #states = new Map<string, SemanticState>();
  readonly epoch: EpochInputs = new EpochInputs();
  readonly metrics: AnalysisCacheMetrics = emptyMetrics();
  readonly inputs: AnalysisInputs;
  readonly invalidation: AnalysisInvalidation;
  readonly queries: Record<string, ResolutionRecord>;
  readonly importers: Record<string, ImporterRecord>;
  readonly projects: AnalysisSnapshot['projects'] = {};
  readonly contributions: ReferenceContributions;
  readonly contexts: Record<string, NativeContextRecord> = {};
  readonly graphs: Record<string, GraphRecord> = {};

  readonly identity: string;
  readonly configVersion: string | undefined;
  readonly previous: AnalysisSnapshot | undefined;
  constructor(
    identity: string,
    previous?: AnalysisSnapshot,
    configVersion?: string,
  ) {
    this.identity = identity;
    this.configVersion = configVersion;
    this.previous = matchingConfigSnapshot(previous, identity, configVersion);
    const state = this.previous ?? emptySnapshot(identity, configVersion);
    this.inputs = new AnalysisInputs(state.inputs, this.metrics);
    this.contributions = new ReferenceContributions(
      this.inputs,
      state.contributions,
    );
    this.inputs.validatePrevious();
    this.#validateDomains(state);
    this.invalidation = new AnalysisInvalidation(this.previous, this.inputs);
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
    this.#contexts = new NativeContextRecords(this);
    this.#graphs = new CachedGraphRecords(this);
  }

  #validateDomains(state: AnalysisSnapshot): void {
    const dependencies = Object.values(state.contexts)
      .flatMap((context) => context.environment.domains)
      .flatMap((domain) => domain.dependencies);
    if (dependencies.some((dependency) => !this.inputs.valid(dependency)))
      this.inputs.domainDirty = true;
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

  #recordProject(id: string, record: ProjectRecord): void {
    this.projects[id] = retainData(this.previous?.projects[id], record);
  }

  #physicalProject(project: TypeScriptSemanticProject): boolean {
    return (project.virtualFiles?.size ?? 0) === 0;
  }

  supports(project: TypeScriptSemanticProject, tsModule: typeof ts): boolean {
    const isSupported = [
      tsModule === ts,
      tsModule.version === '6.0.3',
      this.#physicalProject(project),
      project.analysisBinding !== undefined,
    ].every(Boolean);
    if (!isSupported) {
      this.#hasUnsupportedContext = true;
      this.fallback('unsupported-native-context');
    }
    return isSupported;
  }

  hasCompleteGraphContextCoverage(): boolean {
    return !this.#hasUnsupportedContext && this.#executableContexts.size === 0;
  }

  increment(metric: string): void {
    this.metrics[metric] = (this.metrics[metric] ?? 0) + 1;
  }
  fallback(reason: string): void {
    this.metrics.fallbacks += 1;
    const key = `fallback-${reason}`;
    this.metrics[key] = (this.metrics[key] ?? 0) + 1;
  }

  qualifyFacts(project: TypeScriptSemanticProject, isReusable: boolean): void {
    if (isReusable) return;
    const id = nativeContextId(project);
    this.#executableContexts.add(id);
    this.fallback('semantic-provider-executable');
  }
  hasReusableFacts(project: TypeScriptSemanticProject): boolean {
    return !this.#executableContexts.has(nativeContextId(project));
  }
  registerContextCapture(
    project: TypeScriptSemanticProject,
    program: ts.Program,
    capture: () => void,
  ): void {
    this.#captures.set(nativeContextId(project), { program, capture });
  }
  captureLiveContexts(): void {
    for (const record of this.#captures.values()) record.capture();
  }
  recordProgram(): void {
    this.metrics.semanticPrograms += 1;
  }
  beginContext(project: TypeScriptSemanticProject): void {
    this.#contexts.begin(project);
  }
  observeCompilerInput(
    project: TypeScriptSemanticProject,
    dependency: InputDependency,
  ): void {
    if (this.#resolving === 0) this.#contexts.observe(project, dependency);
  }
  captureContext(
    project: TypeScriptSemanticProject,
    program: ts.Program,
    collect: () => void,
  ): void {
    const state = this.#states.get(nativeContextId(project));
    if (state?.options.program !== program) return;
    collect();
    this.#facts.finish(state.contextId);
    this.#contexts.capture(project, state);
  }
  restoreContext(
    project: TypeScriptSemanticProject,
  ): TypeScriptSemanticDependencyContext | undefined {
    return this.#contexts.restore(project);
  }
  restoreQuery(id: string, record: ResolutionRecord): void {
    this.#resolutions.restore(id, record);
  }

  query<T>(query: ResolutionQuery<T>): T {
    this.#resolving += 1;
    try {
      return this.#resolutions.query(query);
    } finally {
      this.#resolving -= 1;
    }
  }

  prepare(
    project: TypeScriptSemanticProject,
    program: ts.Program,
    tsModule: typeof ts,
  ): () => void {
    const id = nativeContextId(project);
    const state = new SemanticState({
      project,
      program,
      tsModule,
      inputs: this.inputs,
      queries: this.queries,
      queriesByFile: this.#resolutions.byFile(id),
      environmentDependencies:
        this.#contexts.environment(id)?.dependencies ?? [],
    });
    this.#states.set(id, state);
    this.#facts.prepare(id);
    this.#recordProject(id, state.projectRecord);
    return () => {
      if (this.#states.get(id) !== state) {
        return;
      }

      this.#states.delete(id);
      this.#captures.delete(id);
    };
  }

  fact(request: FactRequest): NativeDependencyFact {
    if (!this.hasReusableFacts(request.project)) {
      this.metrics.factQueries += 1;
      return request.collect();
    }
    return this.#facts.fact(
      request,
      this.#states.get(nativeContextId(request.project))!,
    );
  }

  restoreGraphRecord(
    key: string,
    workspaceVersion: string,
  ): Promise<GraphRecord | undefined> {
    return this.#graphs.restore(key, workspaceVersion);
  }
  captureGraphRecord(
    key: string,
    options: {
      workspaceVersion: string;
      value: unknown;
    },
  ): void {
    this.#graphs.capture(key, options);
  }
  snapshotRecords(): Omit<AnalysisSnapshot, 'header'> {
    return currentSnapshotRecords(this);
  }

  isUnchanged(): boolean {
    if (this.previous === undefined) return false;
    const records = this.snapshotRecords();
    return Object.entries(records).every(([key, value]) =>
      areSameRecords(this.previous![key as keyof typeof records], value),
    );
  }

  snapshot(): AnalysisSnapshot {
    if (this.isUnchanged()) return this.previous!;
    this.metrics.snapshotClones = (this.metrics.snapshotClones ?? 0) + 1;
    return newSnapshot(this);
  }
}
