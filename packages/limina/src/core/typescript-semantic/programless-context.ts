import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import ts from 'typescript';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { captureProgramlessContext } from '../analysis-cache/programless-capture';
import { decideReferenceRequirement } from '../dependency-semantics';
import type { ImportRecord } from '../import-analysis/records';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import { bindDependencyRequests } from './context-requests';
import type {
  TypeScriptSemanticDependencyContext,
  TypeScriptSemanticProject,
  TypeScriptSemanticResolution,
} from './contracts';
import type { NativeDependencyFact } from './dependency-fact';
import { getEffectiveImporterRoots } from './effective-roots';
import type {
  DependencyRequestTemplate,
  FileDependencyFacts,
} from './file-dependency-facts';
import { createTypeScriptSemanticContextIdentity } from './identity';
import { createImportRecordIdentity } from './import-record';
import {
  assertNativeCapability,
  assertNativeInput,
  NativeCapabilityError,
} from './native-capability';
import type { FileModuleContext } from './native-request-api';
import { loadDependencyFacts, noteNativeMetric } from './programless-inputs';
import { ProgramlessResolution } from './programless-resolution';
import { requestResolutionMode } from './request-context';
import type { SourceSyntaxFactsCache } from './syntax-cache';
export { NativeCapabilityError } from './native-capability';

export class ProgramlessDependencyContext
  implements TypeScriptSemanticDependencyContext
{
  readonly #pending: string[] = [];
  readonly #seen = new Set<string>();
  readonly #roots: Set<string>;
  readonly identity: string;
  readonly files: Map<string, FileDependencyFacts> = new Map();
  readonly records: Map<string, ImportRecord[]> = new Map();
  readonly facts: Map<string, NativeDependencyFact> = new Map();
  readonly boundary: Set<string> = new Set();
  readonly resolver: ProgramlessResolution;
  readonly project: TypeScriptSemanticProject;
  readonly cache: NativeAnalysisCache | undefined;
  readonly syntaxFacts: SourceSyntaxFactsCache | undefined;
  constructor(
    project: TypeScriptSemanticProject,
    cache?: NativeAnalysisCache,
    syntaxFacts?: SourceSyntaxFactsCache,
  ) {
    this.project = {
      ...project,
      fileNames: getEffectiveImporterRoots(project),
    };
    this.cache = cache;
    this.syntaxFacts = syntaxFacts;
    assertNativeCapability(this.project);
    this.identity = createTypeScriptSemanticContextIdentity(project);
    this.resolver = new ProgramlessResolution(project, this.identity, cache);
    this.#roots = new Set(this.project.fileNames.map(normalizeAbsolutePath));
    this.#pending.push(...this.#roots);
    this.#typeInputs();
    this.#drain();
    this.#libraries();
    // Publish only after the entire consumer closure has succeeded.
    if (cache !== undefined) captureProgramlessContext(this, cache);
  }
  #typeInputs(): void {
    for (const name of this.resolver.typeNames()) {
      const target = this.resolver.typeTarget(
        name,
        path.join(
          path.dirname(this.project.configPath),
          '__inferred type names__.ts',
        ),
      );
      if (target !== undefined) this.#pending.push(target);
    }
  }
  #libraries(): void {
    if (
      this.project.options.noLib ||
      this.files.values().some((file) => file.noDefaultLib)
    )
      return;
    const libraries = this.#libraryNames();
    this.#pending.push(...libraries.map((name) => this.resolver.library(name)));
    this.#drain();
  }
  #libraryNames(): readonly string[] {
    return (
      this.project.options.lib ?? [
        path.basename(ts.getDefaultLibFilePath(this.project.options)),
      ]
    );
  }
  #isForeign(file: string): boolean {
    return [
      !this.#roots.has(file),
      !isDeclarationFile(file),
      this.project.workspaceSourceBoundary.has(file),
    ].every(Boolean);
  }
  #visit(file: string): void {
    this.boundary.add(file);
    if (this.#seen.has(file)) return;
    this.#seen.add(file);
    noteNativeMetric(this.cache, 'closureNodeVisits');
    if (isDeclarationFile(file))
      noteNativeMetric(this.cache, 'declarationNodeVisits');
    this.#collect(file);
  }
  #collect(file: string): void {
    if (this.#isForeign(file)) return;
    assertNativeInput(file);
    const syntax = loadDependencyFacts({
      file,
      cache: this.cache,
      syntaxFacts: this.syntaxFacts,
      host: this.resolver.host,
    });
    if (syntax === undefined) return;
    this.#collectSyntax(syntax);
  }
  #collectSyntax(syntax: FileDependencyFacts): void {
    const file = syntax.filePath;
    this.files.set(file, syntax);
    const mode = this.resolver.format(file);
    const requests = bindDependencyRequests(syntax, this.project, mode);
    this.records.set(
      file,
      requests.map((request) => request.occurrence),
    );
    for (const request of requests) this.#request(syntax, request, mode);
    if (!this.project.options.noLib)
      this.#pending.push(
        ...syntax.libraries.map((name) => this.resolver.library(name)),
      );
  }
  #drain(): void {
    while (this.#pending.length > 0)
      this.#visit(normalizeAbsolutePath(this.#pending.shift()!));
  }
  #request(
    file: FileDependencyFacts,
    request: DependencyRequestTemplate,
    format: FileModuleContext,
  ): void {
    const record = request.occurrence;
    const mode =
      record.kind === 'triple-slash-path'
        ? undefined
        : requestResolutionMode({
            facts: file,
            request,
            options: this.project.options,
            moduleContext: format,
          });
    if (record.configurationSource !== undefined)
      record.configurationSource.resolutionMode = mode;
    const resolution = this.resolver.resolve(record, mode);
    const canExpand = this.#admitTarget(resolution, request);
    this.facts.set(
      createImportRecordIdentity(record),
      this.#fact(resolution, request, canExpand),
    );
  }
  #admitTarget(
    resolution: TypeScriptSemanticResolution,
    request: DependencyRequestTemplate,
  ): boolean {
    const target = resolution.target?.resolvedFileName;
    if (target === undefined) return false;
    this.boundary.add(target);
    const canExpand = [
      request.expansion,
      !this.project.options.noResolve,
    ].every(Boolean);
    this.#enqueue(target, canExpand);
    return canExpand;
  }
  #enqueue(target: string, canExpand: boolean): void {
    if (canExpand) this.#pending.push(target);
  }
  #fact(
    resolution: TypeScriptSemanticResolution,
    request: DependencyRequestTemplate,
    canExpand: boolean,
  ): NativeDependencyFact {
    const decision = decideReferenceRequirement({
      target: request.governance ? resolution.target : null,
    });
    if (decision.state !== 'decided')
      throw new NativeCapabilityError('unobserved reference requirement');
    return {
      resolution,
      referenceRequirement: decision.value,
      admission: this.#admission(resolution, canExpand),
    };
  }
  #admission(
    resolution: TypeScriptSemanticResolution,
    canExpand: boolean,
  ): NativeDependencyFact['admission'] {
    if (resolution.target === null) return 'unresolved';
    return this.#isAdmitted(resolution.target.resolvedFileName, canExpand)
      ? 'admitted'
      : 'excluded';
  }
  #isAdmitted(target: string, canExpand: boolean): boolean {
    return this.#roots.has(target) || (canExpand && !this.#isForeign(target));
  }
  getContributionFileNames(): readonly string[] {
    return this.files.keys().toArray();
  }
  hasSourceFile(file: string): boolean {
    return this.files.has(normalizeAbsolutePath(file));
  }
  getImportRecords(file: string): readonly ImportRecord[] {
    return this.records.get(normalizeAbsolutePath(file)) ?? [];
  }
  getDependencyFact(record: ImportRecord): NativeDependencyFact {
    const fact = this.facts.get(createImportRecordIdentity(record));
    if (fact === undefined)
      throw new Error(
        `Unobserved dependency occurrence: ${record.filePath}:${record.line}`,
      );
    return fact;
  }
  resolveImportRecord(record: ImportRecord): TypeScriptSemanticResolution {
    return this.getDependencyFact(record).resolution;
  }
  dispose(): void {
    this.files.clear();
    this.records.clear();
    this.facts.clear();
  }
}
