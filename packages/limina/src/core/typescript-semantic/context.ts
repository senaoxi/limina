import { isNativeTypeScriptProjectInput } from '#checkers';
import { normalizeAbsolutePath } from '#utils/path';
import ts from 'typescript';
import { nativeContextId } from '../analysis-cache/identity';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import type { ImportRecord } from '../import-analysis/records';
import type { createAmbientTypeEvidence } from '../type-evidence/ambient-symbol';
import { TypeScriptInclusionLedger } from './admission';
import {
  beginNativeAnalysis,
  collectContextFact,
  prepareNativeAnalysis,
} from './cache-lifecycle';
import {
  activeSyntaxScope,
  type ContextServices,
  createStableBoundedProgram,
  resolveAnalysisCache,
  resolveServices,
} from './context-services';
import type {
  TypeScriptSemanticContext,
  TypeScriptSemanticProject,
  TypeScriptSemanticResolution,
} from './contracts';
import { isDependencyContributionInput } from './contribution-inputs';
import type { DeclarationEntry } from './declaration-closure';
import type { NativeDependencyFact } from './dependency-fact';
import { getEffectiveImporterRoots } from './effective-roots';
import { createTypeScriptSemanticHost } from './host';
import { createTypeScriptSemanticContextIdentity } from './identity';
import { createImportRecordIdentity } from './import-record';
import { TypeScriptImportResolver } from './import-resolver';
import { TypeCheckerObservation } from './metrics';
import { TypeScriptResolutionLedger } from './resolution-ledger';
import { collectSemanticSourceRecords } from './source-records';
import type { SourceSyntaxFactsCache } from './syntax-cache';
import { type OwnedSyntaxInput, OwnedSyntaxScope } from './syntax-input';
import { collectTypeEnvironmentEntries } from './type-environment-entries';
function normalizeProject(
  project: TypeScriptSemanticProject,
): TypeScriptSemanticProject {
  return {
    ...project,
    fileNames: getEffectiveImporterRoots(project).filter(
      isNativeTypeScriptProjectInput,
    ),
  };
}
export class BoundedTypeScriptSemanticContext
  implements TypeScriptSemanticContext
{
  readonly #admission: TypeScriptInclusionLedger;
  readonly #host: ts.CompilerHost;
  readonly #ledger = new TypeScriptResolutionLedger();
  readonly #recordsByFile = new Map<string, readonly ImportRecord[]>();
  readonly #facts = new Map<string, NativeDependencyFact>();
  readonly #resolver: TypeScriptImportResolver;
  readonly #sourceFiles = new Map<string, ts.SourceFile>();
  readonly #getAmbientEvidence: typeof createAmbientTypeEvidence;
  readonly #syntaxFacts: SourceSyntaxFactsCache | undefined;
  readonly #checkerObservation: TypeCheckerObservation;
  readonly #analysisCache: NativeAnalysisCache | undefined;
  #disposed = false;
  readonly #releaseAnalysisState: (() => void) | undefined;
  readonly identity: string;
  readonly project: TypeScriptSemanticProject;
  readonly tsModule: typeof ts;
  readonly program: ts.Program;

  constructor(
    project: TypeScriptSemanticProject,
    tsModule: typeof ts = ts,
    options: ContextServices = {},
  ) {
    const services = resolveServices(options);
    this.#getAmbientEvidence = services.getAmbientEvidence;
    this.#syntaxFacts = options.syntaxFacts;
    this.#checkerObservation = new TypeCheckerObservation(services.metrics);
    const syntaxScope = new OwnedSyntaxScope(project.options, tsModule);
    this.project = normalizeProject(project);
    this.#analysisCache = resolveAnalysisCache({
      project: this.project,
      tsModule,
      cache: options.analysisCache,
    });
    this.tsModule = tsModule;
    beginNativeAnalysis(this.#analysisCache, this.project);
    this.identity = createTypeScriptSemanticContextIdentity(this.project);
    this.#admission = new TypeScriptInclusionLedger(this.project, tsModule);
    this.#resolver = new TypeScriptImportResolver({
      addRecord: (record) => this.#addRecord(record),
      admission: this.#admission,
      contextIdentity: this.identity,
      getHost: () => this.#host,
      getRecords: (fileName) => this.#getRecords(fileName),
      getSourceFile: (fileName) => this.#getRegisteredSourceFile(fileName),
      ledger: this.#ledger,
      project: this.project,
      tsModule,
      analysisCache: this.#analysisCache,
      analysisContextId: nativeContextId(this.project),
    });
    this.#host = createTypeScriptSemanticHost({
      project: this.project,
      callbacks: {
        allowSourceFile: (fileName) => this.#allowSourceFile(fileName),
        onDefaultLib: (fileName) => this.#admission.addDefaultLib(fileName),
        onSourceFile: (sourceFile, input) =>
          this.#registerSourceFile(sourceFile, input),
        resolveLibrary: (input) => this.#resolver.resolveLibrary(input),
        resolveModuleNameLiterals: (input) =>
          this.#resolver.resolveModuleNameLiterals(input),
        resolveTypeReferenceDirectiveReferences: (input) =>
          this.#resolver.resolveTypeReferenceDirectiveReferences(input),
      },
      compilerOptions: this.project.options,
      virtualFiles: this.project.virtualFiles,
      syntaxScope: activeSyntaxScope(options.syntaxFacts, syntaxScope),
      tsModule,
      analysisCache: this.#analysisCache,
    });
    this.program = createStableBoundedProgram({
      project: this.project,
      host: this.#host,
      admission: this.#admission,
      tsModule,
      syntaxScope,
      metrics: services.metrics,
      analysisCache: this.#analysisCache,
      reset: () => {
        this.#sourceFiles.clear();
        this.#recordsByFile.clear();
        this.#resolver.dispose();
      },
    });
    this.#releaseAnalysisState = prepareNativeAnalysis({
      cache: this.#analysisCache,
      project: this.project,
      program: this.program,
      tsModule: this.tsModule,
      capture: () => this.#captureAnalysis(),
    });
  }

  #allowSourceFile(fileName: string): boolean {
    const isAllowed =
      this.#admission.has(fileName) ||
      this.#admission.allowDefaultLib(fileName);
    if (!isAllowed) this.#admission.exclude(fileName);
    return isAllowed;
  }

  #registerSourceFile(
    sourceFile: ts.SourceFile,
    syntaxInput?: OwnedSyntaxInput,
  ): void {
    const fileName = normalizeAbsolutePath(sourceFile.fileName);
    if (this.#sourceFiles.has(fileName)) return;
    this.#sourceFiles.set(fileName, sourceFile);
    this.#recordsByFile.set(
      fileName,
      collectSemanticSourceRecords({
        admission: this.#admission,
        contextIdentity: this.identity,
        ledger: this.#ledger,
        syntaxFacts: this.#syntaxFacts,
        syntaxInput,
        sourceFile,
        tsModule: this.tsModule,
        analysisCache: this.#analysisCache,
        analysisContextId: nativeContextId(this.project),
        compilerOptions: this.project.options,
      }),
    );
  }

  #addRecord(record: ImportRecord): void {
    const records = this.#getRecords(record.filePath);
    if (records.includes(record)) return;
    this.#recordsByFile.set(record.filePath, [...records, record]);
  }

  #getRecords(fileName: string): readonly ImportRecord[] {
    return this.#recordsByFile.get(normalizeAbsolutePath(fileName)) ?? [];
  }

  #getRegisteredSourceFile(fileName: string): ts.SourceFile | undefined {
    return this.#sourceFiles.get(normalizeAbsolutePath(fileName));
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error('TypeScript semantic context was disposed.');
    }
  }

  #captureAnalysis(): void {
    this.#analysisCache?.captureContext(this.project, this.program, {
      isCovered: () =>
        this.getContributionFileNames().every((file) =>
          this.#getRecords(file).every((record) =>
            this.#facts.has(createImportRecordIdentity(record)),
          ),
        ),
      entries: this.getTypeEnvironmentEntries(),
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    try {
      this.#captureAnalysis();
    } finally {
      this.#disposed = true;
      this.#releaseAnalysisState?.();
      this.#recordsByFile.clear();
      this.#facts.clear();
      this.#resolver.dispose();
      this.#sourceFiles.clear();
    }
  }

  getDependencyFact(record: ImportRecord): NativeDependencyFact {
    this.#assertActive();
    const key = createImportRecordIdentity(record);
    let fact = this.#facts.get(key);
    if (fact === undefined) {
      fact = collectContextFact({
        cache: this.#analysisCache,
        project: this.project,
        context: this,
        record,
        getAmbientEvidence: this.#getAmbientEvidence,
        tsModule: this.tsModule,
      });
      this.#facts.set(key, fact);
    }
    return structuredClone(fact);
  }

  getCollectedDependencyFacts(): ReadonlyMap<string, NativeDependencyFact> {
    this.#assertActive();
    return this.#facts;
  }

  getContributionFileNames(): readonly string[] {
    this.#assertActive();
    return this.program
      .getSourceFiles()
      .filter((file) =>
        isDependencyContributionInput(this.project, file.fileName),
      )
      .map((file) => normalizeAbsolutePath(file.fileName));
  }

  getTypeEnvironmentEntries(): DeclarationEntry[] {
    return collectTypeEnvironmentEntries({
      compiler: this.tsModule,
      options: this.project.options,
      host: this.#host,
      configPath: this.project.configPath,
    });
  }

  getImportRecords(fileName: string): readonly ImportRecord[] {
    this.#assertActive();
    return this.#getRecords(fileName);
  }

  getSourceFile(fileName: string): ts.SourceFile | undefined {
    this.#assertActive();
    return this.program.getSourceFile(normalizeAbsolutePath(fileName));
  }

  hasSourceFile(fileName: string): boolean {
    this.#assertActive();
    return this.#getRegisteredSourceFile(fileName) !== undefined;
  }

  getSymbolAtImportRecord(importRecord: ImportRecord): ts.Symbol | undefined {
    this.#assertActive();
    const location = this.#resolver.getSymbolLocation(importRecord);
    return location === undefined
      ? undefined
      : this.#checkerObservation
          .get(this.program)
          .getSymbolAtLocation(location);
  }

  resolveImportRecord(
    importRecord: ImportRecord,
  ): TypeScriptSemanticResolution {
    this.#assertActive();
    return this.#resolver.resolveImportRecord(importRecord);
  }
}
