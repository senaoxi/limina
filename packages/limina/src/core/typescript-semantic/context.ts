import { isNativeTypeScriptProjectInput } from '#checkers';
import { normalizeAbsolutePath } from '#utils/path';
import ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import { TypeScriptInclusionLedger } from './admission';
import type {
  TypeScriptSemanticContext,
  TypeScriptSemanticProject,
  TypeScriptSemanticResolution,
} from './contracts';
import { createTypeScriptSemanticHost } from './host';
import { createTypeScriptSemanticContextIdentity } from './identity';
import { TypeScriptImportResolver } from './import-resolver';
import { TypeScriptResolutionLedger } from './resolution-ledger';
import { collectSemanticSourceRecords } from './source-records';

function normalizeProject(
  project: TypeScriptSemanticProject,
): TypeScriptSemanticProject {
  return {
    ...project,
    fileNames: project.fileNames.filter(isNativeTypeScriptProjectInput),
  };
}

export class BoundedTypeScriptSemanticContext
  implements TypeScriptSemanticContext
{
  readonly identity: string;
  readonly #admission: TypeScriptInclusionLedger;
  readonly #host: ts.CompilerHost;
  readonly #ledger = new TypeScriptResolutionLedger();
  readonly #recordsByFile = new Map<string, readonly ImportRecord[]>();
  readonly #resolver: TypeScriptImportResolver;
  readonly #sourceFiles = new Map<string, ts.SourceFile>();
  readonly project: TypeScriptSemanticProject;
  readonly tsModule: typeof ts;
  #disposed = false;
  readonly program: ts.Program;

  constructor(project: TypeScriptSemanticProject, tsModule: typeof ts = ts) {
    this.project = normalizeProject(project);
    this.tsModule = tsModule;
    this.identity = createTypeScriptSemanticContextIdentity(this.project);
    this.#admission = new TypeScriptInclusionLedger(this.project, tsModule);
    this.#resolver = new TypeScriptImportResolver({
      admission: this.#admission,
      contextIdentity: this.identity,
      getHost: () => this.#host,
      getRecords: (fileName) => this.#getRecords(fileName),
      getSourceFile: (fileName) => this.#getRegisteredSourceFile(fileName),
      ledger: this.#ledger,
      project: this.project,
      tsModule,
    });
    this.#host = createTypeScriptSemanticHost({
      callbacks: {
        allowSourceFile: (fileName) => this.#allowSourceFile(fileName),
        onDefaultLib: (fileName) => this.#admission.addDefaultLib(fileName),
        onSourceFile: (sourceFile) => this.#registerSourceFile(sourceFile),
        resolveLibrary: (input) => this.#resolver.resolveLibrary(input),
        resolveModuleNameLiterals: (input) =>
          this.#resolver.resolveModuleNameLiterals(input),
        resolveTypeReferenceDirectiveReferences: (input) =>
          this.#resolver.resolveTypeReferenceDirectiveReferences(input),
      },
      compilerOptions: this.project.options,
      tsModule,
    });
    this.program = tsModule.createProgram({
      host: this.#host,
      options: this.project.options,
      projectReferences: this.project.projectReferences,
      rootNames: [...this.project.fileNames],
    });
  }

  dispose(): void {
    this.#disposed = true;
    this.#recordsByFile.clear();
    this.#resolver.dispose();
    this.#sourceFiles.clear();
  }

  getImportRecords(fileName: string): readonly ImportRecord[] {
    this.#assertActive();
    return this.#getRecords(fileName);
  }

  getSourceFile(fileName: string): ts.SourceFile | undefined {
    this.#assertActive();
    return this.program.getSourceFile(normalizeAbsolutePath(fileName));
  }

  getSymbolAtImportRecord(importRecord: ImportRecord): ts.Symbol | undefined {
    this.#assertActive();
    const location = this.#resolver.getSymbolLocation(importRecord);
    return location === undefined
      ? undefined
      : this.program.getTypeChecker().getSymbolAtLocation(location);
  }

  resolveImportRecord(
    importRecord: ImportRecord,
  ): TypeScriptSemanticResolution {
    this.#assertActive();
    return this.#resolver.resolveImportRecord(importRecord);
  }

  #allowSourceFile(fileName: string): boolean {
    if (this.#admission.has(fileName)) return true;
    return this.#admission.allowDefaultLib(fileName);
  }

  #registerSourceFile(sourceFile: ts.SourceFile): void {
    const fileName = normalizeAbsolutePath(sourceFile.fileName);
    if (this.#sourceFiles.has(fileName)) return;
    this.#sourceFiles.set(fileName, sourceFile);
    this.#recordsByFile.set(
      fileName,
      collectSemanticSourceRecords({
        admission: this.#admission,
        contextIdentity: this.identity,
        ledger: this.#ledger,
        sourceFile,
        tsModule: this.tsModule,
      }),
    );
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
}

export function createBoundedTypeScriptSemanticContext(
  project: TypeScriptSemanticProject,
): TypeScriptSemanticContext {
  return new BoundedTypeScriptSemanticContext(project);
}
