import path from 'node:path';
import type ts from 'typescript';
import type {
  ImportRecord,
  ImportRecordKind,
} from '../import-analysis/records';
import type { TypeScriptInclusionLedger } from './admission';
import type {
  TypeScriptSemanticProject,
  TypeScriptSemanticResolution,
} from './contracts';
import type {
  HostLibraryResolutionInput,
  HostModuleResolutionInput,
  HostTypeReferenceResolutionInput,
} from './host';
import { createImportRecordIdentity } from './import-record';
import { resolveTypeScriptLibrary } from './library-resolution';
import {
  createSyntheticImportRecord,
  findSemanticModuleRecord,
  getStandaloneModuleLocation,
} from './module-records';
import {
  createMissingSemanticResolution,
  resolveModuleSemanticRecord,
  resolveTripleSlashPathSemanticRecord,
} from './resolution';
import type { TypeScriptResolutionLedger } from './resolution-ledger';
import { TypeScriptTypeReferenceResolver } from './type-reference-resolver';

export interface TypeScriptImportResolverOptions {
  admission: TypeScriptInclusionLedger;
  contextIdentity: string;
  getHost(): ts.ModuleResolutionHost;
  getRecords(fileName: string): readonly ImportRecord[];
  getSourceFile(fileName: string): ts.SourceFile | undefined;
  ledger: TypeScriptResolutionLedger;
  project: TypeScriptSemanticProject;
  tsModule: typeof ts;
}

function createCanonicalFileName(tsModule: typeof ts) {
  return tsModule.sys.useCaseSensitiveFileNames
    ? (fileName: string) => fileName
    : (fileName: string) => fileName.toLowerCase();
}

function getModuleChannel(
  importRecord: ImportRecord,
): 'jsx-runtime' | 'module' {
  return importRecord.kind === 'jsx-import-source' ? 'jsx-runtime' : 'module';
}

export class TypeScriptImportResolver {
  readonly #moduleResolutionCache: ts.ModuleResolutionCache;
  readonly options: TypeScriptImportResolverOptions;
  readonly #symbolLocations = new Map<string, ts.StringLiteralLike>();
  readonly #typeReferences: TypeScriptTypeReferenceResolver;

  constructor(options: TypeScriptImportResolverOptions) {
    this.options = options;
    const currentDirectory = path.dirname(options.project.configPath);
    const canonicalFileName = createCanonicalFileName(options.tsModule);
    this.#moduleResolutionCache = options.tsModule.createModuleResolutionCache(
      currentDirectory,
      canonicalFileName,
      options.project.options,
    );
    this.#typeReferences = new TypeScriptTypeReferenceResolver(
      options,
      this.#moduleResolutionCache,
    );
  }

  dispose(): void {
    this.#symbolLocations.clear();
  }

  getSymbolLocation(
    importRecord: ImportRecord,
  ): ts.StringLiteralLike | undefined {
    return this.#symbolLocations.get(createImportRecordIdentity(importRecord));
  }

  resolveImportRecord(
    importRecord: ImportRecord,
  ): TypeScriptSemanticResolution {
    const cached = this.options.ledger.get(importRecord);
    if (cached !== undefined) return cached;
    const resolution = this.#resolveUncachedRecord(importRecord);
    this.options.ledger.set(importRecord, resolution);
    return resolution;
  }

  resolveModuleNameLiterals(
    input: HostModuleResolutionInput,
  ): readonly ts.ResolvedModuleWithFailedLookupLocations[] {
    const records = this.options.getRecords(input.containingFile);
    return input.literals.map((literal) =>
      this.#resolveHostModuleLiteral({ input, literal, records }),
    );
  }

  resolveLibrary(
    input: HostLibraryResolutionInput,
  ): ts.ResolvedModuleWithFailedLookupLocations {
    return resolveTypeScriptLibrary({
      admission: this.options.admission,
      cache: this.#moduleResolutionCache,
      host: this.options.getHost(),
      input,
      tsModule: this.options.tsModule,
    });
  }

  resolveTypeReferenceDirectiveReferences(
    input: HostTypeReferenceResolutionInput,
  ): readonly ts.ResolvedTypeReferenceDirectiveWithFailedLookupLocations[] {
    return this.#typeReferences.resolveHost(input);
  }

  #resolveHostModuleLiteral(options: {
    input: HostModuleResolutionInput;
    literal: ts.StringLiteralLike;
    records: readonly ImportRecord[];
  }): ts.ResolvedModuleWithFailedLookupLocations {
    const record = findSemanticModuleRecord({
      literal: options.literal,
      records: options.records,
      sourceFile: options.input.sourceFile,
    });
    const result = this.#resolveModule({
      ...options.input,
      literal: options.literal,
      record,
    });
    return this.#admitHostModuleResult(result.raw);
  }

  #admitHostModuleResult(
    result: ts.ResolvedModuleWithFailedLookupLocations,
  ): ts.ResolvedModuleWithFailedLookupLocations {
    const resolved = result.resolvedModule;
    if (resolved === undefined) return result;
    if (this.options.admission.allowModuleTarget(resolved)) return result;
    return { ...result, resolvedModule: undefined };
  }

  #resolveModule(options: {
    compilerOptions: ts.CompilerOptions;
    containingFile: string;
    literal: ts.StringLiteralLike;
    record: ImportRecord | undefined;
    redirectedReference: ts.ResolvedProjectReference | undefined;
    sourceFile: ts.SourceFile;
  }) {
    const importRecord = options.record ?? createSyntheticImportRecord(options);
    const result = resolveModuleSemanticRecord({
      ...options,
      channel: getModuleChannel(importRecord),
      contextIdentity: this.options.contextIdentity,
      host: this.options.getHost(),
      importRecord,
      moduleResolutionCache: this.#moduleResolutionCache,
      tsModule: this.options.tsModule,
    });
    this.#storeOptionalModuleOccurrence({
      importRecord: options.record,
      literal: options.literal,
      resolution: result.semantic,
    });
    return result;
  }

  #storeOptionalModuleOccurrence(options: {
    importRecord: ImportRecord | undefined;
    literal: ts.StringLiteralLike;
    resolution: TypeScriptSemanticResolution;
  }): void {
    if (options.importRecord === undefined) return;
    this.#storeModuleOccurrence(
      options.importRecord,
      options.literal,
      options.resolution,
    );
  }

  #storeModuleOccurrence(
    importRecord: ImportRecord,
    literal: ts.StringLiteralLike,
    resolution: TypeScriptSemanticResolution,
  ): void {
    this.options.ledger.set(importRecord, resolution);
    this.#symbolLocations.set(
      createImportRecordIdentity(importRecord),
      literal,
    );
  }

  #resolveUncachedRecord(
    importRecord: ImportRecord,
  ): TypeScriptSemanticResolution {
    const special = this.#getSpecialResolver(importRecord.kind);
    return special === undefined
      ? this.#resolveStandaloneModule(importRecord)
      : special(importRecord);
  }

  #getSpecialResolver(
    kind: ImportRecordKind,
  ):
    | ((importRecord: ImportRecord) => TypeScriptSemanticResolution)
    | undefined {
    const resolvers: Partial<
      Record<
        ImportRecordKind,
        (importRecord: ImportRecord) => TypeScriptSemanticResolution
      >
    > = {
      'environment-pragma': (record) =>
        this.#createMissing(record, 'environment-pragma'),
      'jsx-import-source': (record) =>
        this.#createMissing(record, 'jsx-runtime'),
      'triple-slash-path': (record) =>
        resolveTripleSlashPathSemanticRecord({
          contextIdentity: this.options.contextIdentity,
          importRecord: record,
          tsModule: this.options.tsModule,
        }),
      'triple-slash-types': (record) =>
        this.#typeReferences.resolveStandalone(record),
    };
    return resolvers[kind];
  }

  #createMissing(
    importRecord: ImportRecord,
    channel: 'environment-pragma' | 'jsx-runtime' | 'module',
  ): TypeScriptSemanticResolution {
    return createMissingSemanticResolution({
      channel,
      contextIdentity: this.options.contextIdentity,
      importRecord,
    });
  }

  #resolveStandaloneModule(
    importRecord: ImportRecord,
  ): TypeScriptSemanticResolution {
    const location = getStandaloneModuleLocation({
      getSourceFile: this.options.getSourceFile,
      importRecord,
      tsModule: this.options.tsModule,
    });
    if (location === null) return this.#createMissing(importRecord, 'module');
    return this.#resolveModule({
      compilerOptions: this.options.project.options,
      containingFile: importRecord.filePath,
      literal: location.literal,
      record: importRecord,
      redirectedReference: undefined,
      sourceFile: location.sourceFile,
    }).semantic;
  }
}
