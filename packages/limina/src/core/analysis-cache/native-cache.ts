import ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import { nativeHostContract } from '../typescript-semantic/compiler-path-key';
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
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import { emptyMetrics } from './cache-metrics';
import { NativeContextRecords } from './context-records';
import type {
  AnalysisCacheMetrics,
  AnalysisSnapshot,
  ConfigModuleSnapshot,
  ImporterRecord,
  InputDependency,
  NativeContextRecord,
  ProjectRecord,
  ResolutionRecord,
  SourceConfigAuthority,
} from './contracts';
import { AnalysisInputDriftError } from './contracts';
import { type EpochInputReplay, EpochInputs } from './epoch-inputs';
import { analysisHash, nativeContextId } from './identity';
import { type FactRequest, ImporterFacts } from './importer-facts';
import { AnalysisInputs } from './inputs';
import { AnalysisInvalidation } from './invalidation';
import { InvocationConfigReads } from './invocation-config-reads';
import {
  capturePackageScopes,
  invalidatedPackageConfigs,
} from './package-scopes';
import {
  activeCacheDecision,
  type CacheDecisionReference,
  type CacheOrigin,
  keepCacheDecision,
  recordCacheHit,
  recordCacheMiss,
} from './profile-decisions';
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
import { SourceConfigProjectionCache } from './source-config-projection';
import { VueAnalysisRecords } from './vue-records';
import { observePreviousVueBytes } from './vue-toolchain-inputs';
export class NativeAnalysisCache {
  readonly #fileSyntax = new Map<string, FileDependencyFacts>();
  readonly #invalidatedSources = new Set<string>();
  readonly #rebuiltSyntax = new Map<string, Map<string, FileDependencyFacts>>();
  readonly #syntaxWitnesses = new Map<string, Map<string, string>>();
  readonly #syntaxProofs = new Map<string, string>();
  readonly #resolutions: ResolutionQueries;
  readonly #runtimeResolutions: ResolutionQueries;
  readonly #runtimeMetrics: AnalysisCacheMetrics;
  readonly #facts: ImporterFacts;
  readonly #contexts: NativeContextRecords;
  #resolving = 0;
  #snapshotDecision?: CacheDecisionReference;
  readonly #executableContexts = new Set<string>();
  readonly #incompleteCollections = new Set<string>();
  readonly #captures = new Map<
    string,
    { program: ts.Program; capture(): void }
  >();
  readonly #states = new Map<string, SemanticState>();
  readonly epoch: EpochInputs;
  readonly metrics: AnalysisCacheMetrics = emptyMetrics();
  readonly configReads: InvocationConfigReads;
  readonly sourceConfigProjections: SourceConfigProjectionCache;
  readonly inputs: AnalysisInputs;
  packageScopes: AnalysisSnapshot['header']['packageScopes'] = {
    manifests: {},
    configs: {},
  };
  readonly invalidation: AnalysisInvalidation;
  readonly queries: Record<string, ResolutionRecord>;
  readonly runtimeQueries: Record<string, ResolutionRecord>;
  readonly retainedQueryIds: ReadonlySet<string>;
  readonly importers: Record<string, ImporterRecord>;
  readonly files: AnalysisSnapshot['files'] = {};
  readonly projects: AnalysisSnapshot['projects'] = {};
  readonly contexts: Record<string, NativeContextRecord> = {};
  readonly vue: VueAnalysisRecords;
  readonly configClosures: Map<string, readonly string[]> = new Map();
  readonly identity: string;
  readonly configVersion: string | undefined;
  readonly configModules: ConfigModuleSnapshot;
  readonly previous: AnalysisSnapshot | undefined;
  readonly previousOrigin: CacheOrigin;

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
    this.previousOrigin = config.previousOrigin ?? 'unknown';
    this.sourceConfigProjections = new SourceConfigProjectionCache({
      previous: this.previous,
      previousOrigin: this.previousOrigin,
      packageScopes: () => this.packageScopes,
      invalidate: (file) => this.invalidateSourceConfig(file),
    });
    this.configReads = new InvocationConfigReads(
      this.metrics,
      this.sourceConfigProjections,
    );
    const state = this.previous ?? emptySnapshot(identity, this.configVersion);
    const baselineTime = this.previous?.header.baselineTime;
    this.inputs = new AnalysisInputs(
      state.inputs,
      this.metrics,
      baselineTime === undefined
        ? undefined
        : { baselineTime, generation: state.header.revision },
      config.liveConfigTimes,
    );
    this.epoch = new EpochInputs(this.inputs);
    observePreviousVueBytes(state, this.inputs);
    this.inputs.validatePrevious();
    this.invalidation = new AnalysisInvalidation(this.previous, this.inputs);
    this.#resolutions = new ResolutionQueries({
      inputs: this.inputs,
      metrics: this.metrics,
      previous: state.queries,
      previousReceipt: (id, key) =>
        state.contexts[id]?.native?.queryReceipts?.[key],
      dirty: this.invalidation.resolutionDirty,
      origin: this.previousOrigin,
    });
    this.#runtimeMetrics = emptyMetrics();
    this.#runtimeResolutions = new ResolutionQueries({
      inputs: this.inputs,
      metrics: this.#runtimeMetrics,
      previous: state.runtimeQueries,
      dirty: this.invalidation.runtimeResolutionDirty,
      origin: this.previousOrigin,
    });
    this.#facts = new ImporterFacts({
      inputs: this.inputs,
      metrics: this.metrics,
      previous: state.importers,
      dirty: this.invalidation.semanticDirty,
      origin: this.previousOrigin,
    });
    this.queries = this.#resolutions.records;
    this.runtimeQueries = this.#runtimeResolutions.records;
    this.retainedQueryIds = this.#resolutions.retained;
    this.importers = this.#facts.records;
    this.#contexts = new NativeContextRecords(this);
    this.vue = new VueAnalysisRecords(this);
  }

  #recordProject(id: string, record: ProjectRecord): void {
    this.projects[id] = retainData(this.previous?.projects[id], record);
  }
  #physicalProject(project: TypeScriptSemanticProject): boolean {
    return (project.virtualFiles?.size ?? 0) === 0;
  }

  #syntaxMemo(
    project: TypeScriptSemanticProject | undefined,
  ): Map<string, FileDependencyFacts> {
    if (project === undefined) return this.#fileSyntax;
    const owner = project.sourceConfigPath ?? project.configPath;
    if (
      !this.#invalidatedSources.has(owner) &&
      !this.invalidation.contextDirty.has(nativeContextId(project))
    )
      return this.#fileSyntax;
    let fresh = this.#rebuiltSyntax.get(owner);
    if (fresh === undefined) {
      fresh = new Map<string, FileDependencyFacts>();
      this.#rebuiltSyntax.set(owner, fresh);
    }
    return fresh;
  }

  get snapshotDecision(): string | undefined {
    return activeCacheDecision(this.#snapshotDecision);
  }

  set snapshotDecision(decision: string | undefined) {
    this.#snapshotDecision = keepCacheDecision(decision);
  }

  observePackageScopes(
    regions: WorkspaceRegionPathIndex,
    sources: Iterable<string>,
    solutions: Iterable<string>,
  ): void {
    const current = capturePackageScopes(
      this.inputs,
      regions,
      sources,
      solutions,
    );
    const previous = this.previous?.header.packageScopes;
    if (previous !== undefined)
      for (const config of invalidatedPackageConfigs(previous, current)) {
        this.sourceConfigProjections.revoke(config);
        this.invalidateSourceConfig(config);
      }
    this.packageScopes = current;
  }

  recordSourceConfigAuthority(
    input: SourceConfigAuthority & { configPath: string },
  ): void {
    const { configPath, ...authority } = input;
    const isReusable = this.sourceConfigProjections.recordAuthority(
      configPath,
      authority,
    );
    if (!isReusable && this.previous !== undefined)
      this.invalidateSourceConfig(configPath);
  }

  recordBundledSourceConfigAuthority(
    input: Pick<SourceConfigAuthority, 'source'> & {
      configPath: string;
      family: 'typescript';
    },
  ): void {
    this.recordSourceConfigAuthority({
      ...input,
      provider: 'native-typescript',
      toolchain: nativeHostContract(),
    });
  }

  invalidateSourceConfig(configPath: string): void {
    if (this.#invalidatedSources.has(configPath)) return;
    this.#invalidatedSources.add(configPath);
    this.#rebuiltSyntax.delete(configPath);
    this.vue.invalidateSource(configPath);
    const contexts = { ...this.previous?.contexts, ...this.contexts };
    const owners = new Set(
      Object.entries(contexts)
        .filter(
          ([, { project }]) =>
            project.configPath === configPath ||
            project.sourceConfigPath === configPath,
        )
        .map(([id]) => id),
    );
    for (const id of owners) this.invalidation.invalidateContext(id);
    const queries = { ...this.previous?.queries, ...this.queries };
    const stale = new Set<string>();
    for (const [id, query] of Object.entries(queries)) {
      if (!owners.has(query.contextId)) continue;
      this.invalidation.resolutionDirty.add(id);
      this.#resolutions.evict(id);
      stale.add(id);
    }
    for (const [id, record] of Object.entries(contexts)) {
      if (!owners.has(id) && record.queryIds.every((key) => !stale.has(key)))
        continue;
      this.#contexts.evict(id);
      this.#facts.prepare(id);
      this.#captures.delete(id);
      this.#states.delete(id);
      this.#syntaxWitnesses.delete(id);
      if (owners.has(id)) {
        for (const file of Object.keys(record.sources))
          this.#syntaxProofs.delete(file);
      }
      for (const importer of Object.values(record.sources)) {
        if (importer !== null) delete this.importers[importer];
      }
      delete this.projects[id];
      delete this.contexts[id];
    }
  }

  previousFileSyntax(
    project: TypeScriptSemanticProject,
    file: string,
  ): FileDependencyFacts | undefined {
    const id = nativeContextId(project);
    if (this.invalidation.contextDirty.has(id)) return undefined;
    const facts = this.previous?.files[file];
    if (facts === undefined) return undefined;
    let witnesses = this.#syntaxWitnesses.get(id);
    if (witnesses === undefined) {
      witnesses = new Map(
        this.previous?.contexts[id]?.native?.inventory.syntax.map((witness) => [
          witness.file,
          witness.fingerprint,
        ]),
      );
      this.#syntaxWitnesses.set(id, witnesses);
    }
    return witnesses.get(file) === nativeFingerprint(facts) ? facts : undefined;
  }

  readFileSyntax(
    file: string,
    text: string,
    project?: TypeScriptSemanticProject,
    sourceFile?: ts.SourceFile,
  ): FileDependencyFacts {
    const version = analysisHash(text);
    const physicalVersion =
      project === undefined
        ? undefined
        : this.inputs.observe(file, 'content').expectedVersion;
    const memo = this.#syntaxMemo(project);
    let facts = memo.get(file);
    const isInMemory = facts !== undefined;
    if (
      facts === undefined &&
      project !== undefined &&
      memo === this.#fileSyntax
    )
      facts = this.previousFileSyntax(project, file);
    if (
      facts?.sourceVersion !== version ||
      facts.physicalVersion !== physicalVersion ||
      facts.compilerVersion !== ts.version
    ) {
      recordCacheMiss(
        'native-syntax',
        facts === undefined
          ? 'syntax-witness-or-record-absent'
          : facts.sourceVersion === version
            ? facts.physicalVersion === physicalVersion
              ? 'syntax-compiler-changed'
              : 'syntax-physical-input-changed'
            : 'syntax-text-changed',
        { file, absent: facts === undefined || undefined },
      );
      if (physicalVersion !== undefined) {
        const witnessed = this.inputs.sourceTextVersion(
          file,
          'typescript-content',
        );
        const isWitnessed =
          witnessed === undefined
            ? ts.sys.readFile(file) === text
            : witnessed === version;
        if (!isWitnessed) throw new AnalysisInputDriftError(file);
      }
      facts = extractFileDependencyFacts(file, text, version, sourceFile);
      if (physicalVersion !== undefined)
        facts.physicalVersion = physicalVersion;
      this.increment('syntaxFactBuilds');
    } else {
      this.increment('syntaxFactHits');
      recordCacheHit(
        'native-syntax',
        isInMemory ? 'invocation-memory' : this.previousOrigin,
        file,
      );
    }
    memo.set(file, facts);
    // Only neutral text facts cross contexts. Current Programs still own their
    // requests, resolutions and proof; no caller can mutate this private memo.
    return structuredClone(facts);
  }

  retainSyntax(facts: FileDependencyFacts, fingerprint: string): void {
    if (nativeFingerprint(facts) !== fingerprint) return;
    this.files[facts.filePath] = facts;
    this.#syntaxProofs.set(facts.filePath, fingerprint);
  }
  readFileDependencyFacts(file: string): FileDependencyFacts | undefined {
    const facts = this.files[file];
    if (facts === undefined || facts.compilerVersion !== ts.version) {
      return undefined;
    }
    if (this.#syntaxProofs.get(file) !== nativeFingerprint(facts)) {
      return undefined;
    }
    return this.inputs.observe(file, 'content').expectedVersion ===
      facts.physicalVersion
      ? structuredClone(facts)
      : undefined;
  }
  readSourceSyntax(file: string): ImportRecord[] | undefined {
    const facts = this.files[file];
    if (facts === undefined || facts.compilerVersion !== ts.version) {
      recordCacheMiss(
        'native-source-syntax',
        facts === undefined
          ? 'source-syntax-record-absent'
          : 'syntax-compiler-changed',
        { file, absent: facts === undefined || undefined },
      );
      return undefined;
    }
    if (this.#syntaxProofs.get(file) !== nativeFingerprint(facts)) {
      recordCacheMiss('native-source-syntax', 'syntax-witness-invalid', {
        file,
      });
      return undefined;
    }
    if (
      this.inputs.observe(file, 'content').expectedVersion !==
      facts.physicalVersion
    ) {
      recordCacheMiss('native-source-syntax', 'syntax-physical-input-changed', {
        file,
      });
      return undefined;
    }
    this.increment('sourceSyntaxHits');
    recordCacheHit(
      'native-source-syntax',
      this.previous?.files[file] === facts
        ? this.previousOrigin
        : 'invocation-memory',
      file,
    );
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
    if (!isSupported) this.fallback('unsupported-native-context');
    return isSupported;
  }

  increment(metric: string): void {
    this.metrics[metric] = (this.metrics[metric] ?? 0) + 1;
  }

  noteNativeCollection(
    project: TypeScriptSemanticProject,
    isComplete: boolean,
  ): void {
    const id = nativeContextId(project);
    if (isComplete) this.#incompleteCollections.delete(id);
    else this.#incompleteCollections.add(id);
  }

  get hasIncompleteNativeCollection(): boolean {
    return this.#incompleteCollections.size > 0;
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
  observationPlan(
    project: TypeScriptSemanticProject,
  ): ReturnType<NativeContextRecords['plan']> {
    return this.#contexts.plan(project);
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
    onMiss?: (decision: string) => void,
  ): TypeScriptSemanticDependencyContext | undefined {
    return this.#contexts.restore(
      project,
      replay ?? this.configReads.replay(),
      onMiss,
    );
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

  queryRuntime<T>(query: ResolutionQuery<T>): T {
    const beforeCalls = this.#runtimeMetrics.resolverCalls;
    const beforeHits = this.#runtimeMetrics.queryHits;
    this.#resolving += 1;
    try {
      return this.#runtimeResolutions.query(query);
    } finally {
      this.#resolving -= 1;
      const callsDelta = this.#runtimeMetrics.resolverCalls - beforeCalls;
      const hitsDelta = this.#runtimeMetrics.queryHits - beforeHits;
      if (callsDelta > 0) {
        this.metrics.runtimeResolverCalls =
          (this.metrics.runtimeResolverCalls ?? 0) + callsDelta;
      }
      if (hitsDelta > 0) {
        this.metrics.runtimeQueryHits =
          (this.metrics.runtimeQueryHits ?? 0) + hitsDelta;
      }
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
