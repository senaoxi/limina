import { normalizeAbsolutePath } from '#utils/path';
import path from 'node:path';
import type ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import type { TypeScriptSemanticResolution } from './contracts';
import type { HostTypeReferenceResolutionInput } from './host';
import { findDirectiveRecord } from './import-record';
import type { TypeScriptImportResolverOptions } from './import-resolver';
import { resolveTypeReferenceSemanticRecord } from './resolution';

function createSyntheticTypeReferenceRecord(options: {
  containingFile: string;
  index: number;
  specifier: string;
}): ImportRecord {
  return {
    domain: 'typescript',
    filePath: normalizeAbsolutePath(options.containingFile),
    kind: 'triple-slash-types',
    line: 0,
    locator: {
      occurrence: options.index,
      sourceEnd: -1,
      sourceStart: -1,
    },
    specifier: options.specifier,
  };
}

function getReferenceSpecifier(reference: ts.FileReference | string): string {
  return typeof reference === 'string' ? reference : reference.fileName;
}

export class TypeScriptTypeReferenceResolver {
  readonly #cache: ts.TypeReferenceDirectiveResolutionCache;
  readonly options: TypeScriptImportResolverOptions;

  constructor(
    options: TypeScriptImportResolverOptions,
    packageJsonInfoCache: ts.PackageJsonInfoCache,
  ) {
    this.options = options;
    const currentDirectory = path.dirname(options.project.configPath);
    const canonicalFileName = options.tsModule.sys.useCaseSensitiveFileNames
      ? (fileName: string) => fileName
      : (fileName: string) => fileName.toLowerCase();
    this.#cache = options.tsModule.createTypeReferenceDirectiveResolutionCache(
      currentDirectory,
      canonicalFileName,
      options.project.options,
      packageJsonInfoCache,
    );
  }

  resolveHost(
    input: HostTypeReferenceResolutionInput,
  ): readonly ts.ResolvedTypeReferenceDirectiveWithFailedLookupLocations[] {
    const occurrences = new Map<string, number>();
    const records = this.options.getRecords(input.containingFile);
    return input.references.map((reference, index) => {
      const specifier = getReferenceSpecifier(reference);
      const occurrence = occurrences.get(specifier) ?? 0;
      occurrences.set(specifier, occurrence + 1);
      return this.#resolveHostReference({
        index,
        input,
        occurrence,
        records,
        reference,
        specifier,
      });
    });
  }

  resolveStandalone(importRecord: ImportRecord): TypeScriptSemanticResolution {
    return this.#resolve({
      compilerOptions: this.options.project.options,
      containingFile: importRecord.filePath,
      importRecord,
      redirectedReference: undefined,
      reference: importRecord.specifier,
      sourceFile: this.options.getSourceFile(importRecord.filePath),
    }).semantic;
  }

  #resolveHostReference(options: {
    index: number;
    input: HostTypeReferenceResolutionInput;
    occurrence: number;
    records: readonly ImportRecord[];
    reference: ts.FileReference | string;
    specifier: string;
  }): ts.ResolvedTypeReferenceDirectiveWithFailedLookupLocations {
    const record = findDirectiveRecord({
      kind: 'triple-slash-types',
      occurrence: options.occurrence,
      records: options.records,
      specifier: options.specifier,
    });
    const importRecord =
      record ??
      createSyntheticTypeReferenceRecord({
        containingFile: options.input.containingFile,
        index: options.index,
        specifier: options.specifier,
      });
    const result = this.#resolve({
      ...options.input,
      importRecord,
      reference: options.reference,
    });
    this.#admit(result.raw);
    this.#store(record, result.semantic);
    return result.raw;
  }

  #resolve(options: {
    compilerOptions: ts.CompilerOptions;
    containingFile: string;
    importRecord: ImportRecord;
    redirectedReference: ts.ResolvedProjectReference | undefined;
    reference: ts.FileReference | string;
    sourceFile: ts.SourceFile | undefined;
  }) {
    const containingFileMode = options.sourceFile?.impliedNodeFormat;
    const resolutionMode = this.options.tsModule.getModeForFileReference(
      options.reference,
      containingFileMode as ts.ResolutionMode,
    );
    return resolveTypeReferenceSemanticRecord({
      ...options,
      contextIdentity: this.options.contextIdentity,
      host: this.options.getHost(),
      resolutionMode,
      tsModule: this.options.tsModule,
      typeReferenceDirectiveResolutionCache: this.#cache,
    });
  }

  #admit(
    result: ts.ResolvedTypeReferenceDirectiveWithFailedLookupLocations,
  ): void {
    const target = result.resolvedTypeReferenceDirective?.resolvedFileName;
    if (target !== undefined) this.options.admission.addTypeReference(target);
  }

  #store(
    importRecord: ImportRecord | undefined,
    resolution: TypeScriptSemanticResolution,
  ): void {
    if (importRecord !== undefined) {
      this.options.ledger.set(importRecord, resolution);
    }
  }
}
