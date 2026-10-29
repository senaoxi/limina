import ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import type {
  TypeScriptSemanticDependencyContext,
  TypeScriptSemanticProject,
} from '../typescript-semantic/contracts';
import type { DeclarationEntry } from '../typescript-semantic/declaration-closure';
import type { NativeDependencyFact } from '../typescript-semantic/dependency-fact';
import {
  extractFileDependencyFacts,
  type FileDependencyFacts,
} from '../typescript-semantic/file-dependency-facts';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import { emptyMetrics } from './cache-metrics';
import { NativeContextRecords } from './context-records';
import type {
  AnalysisCacheMetrics,
  AnalysisSnapshot,
  ConfigModuleSnapshot,
  GraphRecord,
  ImporterRecord,
  InputDependency,
  NativeContextRecord,
  ProjectRecord,
  ResolutionRecord,
} from './contracts';
import { ReferenceContributions } from './contributions';
import { type EpochInputReplay, EpochInputs } from './epoch-inputs';
import { CachedGraphRecords } from './graph-records';
import { analysisHash, nativeContextId } from './identity';
import { type FactRequest, ImporterFacts } from './importer-facts';
import { AnalysisInputs } from './inputs';
import { subscribeInstallationDomains } from './installation-environment';
import { restoreInstallationLockCoverage } from './installation-lock-coverage';
import { AnalysisInvalidation } from './invalidation';
import { ResolutionQueries, type ResolutionQuery } from './resolution-queries';
import { SemanticState } from './semantic-state';
import { measuredSnapshot } from './snapshot-measurement';
import {
  type ConfigCacheOptions,
  configCacheState,
  currentSnapshotRecords,
  emptySnapshot,
  isUnchangedCache,
  retainData,
} from './snapshot-records';
import { VueAnalysisRecords } from './vue-records';
import { observePreviousVueBytes } from './vue-toolchain-inputs';
export class NativeAnalysisCache {
  readonly #fileSyntax = new Map<string, FileDependencyFacts>();
  readonly #syntaxProofs = new Map<string, string>();
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
  requiresSupplementalReassessment = false;
  readonly epoch: EpochInputs = new EpochInputs();
  readonly metrics: AnalysisCacheMetrics = emptyMetrics();
  readonly inputs: AnalysisInputs;
  readonly invalidation: AnalysisInvalidation;
  readonly queries: Record<string, ResolutionRecord>;
  readonly retainedQueryIds: ReadonlySet<string>;
  readonly importers: Record<string, ImporterRecord>;
  readonly files: AnalysisSnapshot['files'] = {};
  readonly projects: AnalysisSnapshot['projects'] = {};
  readonly contributions: ReferenceContributions;
  readonly contexts: Record<string, NativeContextRecord> = {};
  readonly graphs: Record<string, GraphRecord> = {};
  readonly vue: VueAnalysisRecords;
  readonly identity: string;
  readonly configVersion: string | undefined;
  readonly configModules: ConfigModuleSnapshot;
  readonly previous: AnalysisSnapshot | undefined;
  constructor(
    identity: string,
    previous?: AnalysisSnapshot,
    options?: string | ConfigCacheOptions,
  ) {
    this.identity = identity;
    const config = configCacheState(identity, previous, options);
    this.configVersion = config.configVersion;
    this.configModules = config.configModules;
    this.previous = config.previous;
    const state = this.previous ?? emptySnapshot(identity, this.configVersion);
    this.inputs = new AnalysisInputs(state.inputs, this.metrics);
    subscribeInstallationDomains(state, this.inputs);
    observePreviousVueBytes(state, this.inputs);
    this.contributions = new ReferenceContributions(
      this.inputs,
      state.contributions,
    );
    this.inputs.validatePrevious();
    this.invalidation = new AnalysisInvalidation(this.previous, this.inputs);
    this.#checkConsumerCoverage();
    restoreInstallationLockCoverage(state, this.inputs);
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
    this.retainedQueryIds = this.#resolutions.retained;
    this.importers = this.#facts.records;
    this.#contexts = new NativeContextRecords(this);
    this.#graphs = new CachedGraphRecords(this);
    this.vue = new VueAnalysisRecords(this);
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

  readFileSyntax(file: string, text: string): FileDependencyFacts {
    const version = analysisHash(text);
    let facts = this.#fileSyntax.get(file);
    if (
      facts?.sourceVersion !== version ||
      facts.compilerVersion !== ts.version
    ) {
      facts = extractFileDependencyFacts(file, text, version);
      this.#fileSyntax.set(file, facts);
      this.increment('syntaxFactBuilds');
    } else this.increment('syntaxFactHits');
    // Only neutral text facts cross contexts. Current Programs still own their
    // requests, resolutions and proof; no caller can mutate this private memo.
    return structuredClone(facts);
  }

  retainSyntax(facts: FileDependencyFacts, fingerprint: string): void {
    if (nativeFingerprint(facts) !== fingerprint) return;
    this.files[facts.filePath] = facts;
    this.#syntaxProofs.set(facts.filePath, fingerprint);
  }
  readSourceSyntax(file: string): ImportRecord[] | undefined {
    const facts = this.files[file];
    if (facts === undefined || facts.compilerVersion !== ts.version)
      return undefined;
    if (this.#syntaxProofs.get(file) !== nativeFingerprint(facts))
      return undefined;
    if (
      this.inputs.observe(file, 'content').expectedVersion !==
      facts.sourceVersion
    )
      return undefined;
    this.increment('sourceSyntaxHits');
    return structuredClone(
      facts.requests
        .filter((request) => !request.externalModuleOnly)
        .map((request) => request.occurrence),
    );
  }
  supports(project: TypeScriptSemanticProject, tsModule: typeof ts): boolean {
    const isSupported = [
      tsModule === ts,
      tsModule.version === '6.0.3',
      this.#physicalProject(project),
      project.declarationContextValidation === undefined,
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
    this.vue.capture();
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
    observation: { isCovered(): boolean; entries: DeclarationEntry[] },
  ): void {
    const state = this.#states.get(nativeContextId(project));
    if (state?.options.program !== program) return;
    const isComplete = observation.isCovered();
    this.#facts.finish(state.contextId);
    this.#contexts.capture(project, state, {
      isComplete,
      entries: observation.entries,
    });
  }
  restoreContext(
    project: TypeScriptSemanticProject,
    replay?: EpochInputReplay,
  ): TypeScriptSemanticDependencyContext | undefined {
    return this.#contexts.restore(project, replay);
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
      if (this.#states.get(id) !== state) return;

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
    generation = 0,
  ): Promise<GraphRecord | undefined> {
    return this.#graphs.restore(key, workspaceVersion, generation);
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
    this.vue.capture();
    return currentSnapshotRecords(this);
  }

  isUnchanged(): boolean {
    return isUnchangedCache(this);
  }

  snapshot(): AnalysisSnapshot {
    if (this.isUnchanged()) return this.previous!;
    this.metrics.snapshotClones = (this.metrics.snapshotClones ?? 0) + 1;
    return measuredSnapshot(this);
  }
}
