import type { ResolvedCheckerModuleName } from '#checkers';
import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import type { TypeScriptSemanticDependencyContext } from '../typescript-semantic';
import {
  createImportRecordIdentity,
  isModuleImportRecord,
} from '../typescript-semantic/import-record';
import { getResolutionOrigin } from '../typescript-semantic/resolution-origin';
import type { NativeRuntimeModuleQuery } from '../typescript-semantic/runtime-module-queries';
import type { ProjectDependencyRequest } from './contracts';
import { NativeRuntimeReceipts } from './native-runtime-receipts';
import {
  collectionProject,
  createCollectionContext,
  restoreCollectionContext,
} from './semantic-facts';

interface RuntimeSourceResolution {
  readonly mode: ts.ResolutionMode;
  readonly target: ResolvedCheckerModuleName | null;
}

export class RuntimeSourceResolver {
  readonly #request: ProjectDependencyRequest;
  readonly #receipts: NativeRuntimeReceipts;
  readonly #results = new Map<string, RuntimeSourceResolution>();
  #native: TypeScriptSemanticDependencyContext | undefined;
  #bounded: ReturnType<typeof createCollectionContext> | undefined;
  #query: NativeRuntimeModuleQuery | undefined;

  constructor(request: ProjectDependencyRequest) {
    this.#request = request;
    this.#receipts = new NativeRuntimeReceipts(
      collectionProject(request),
      request.caches?.analysisCache,
    );
  }

  #createBoundedContext() {
    return (this.#bounded ??= createCollectionContext(
      this.#request,
      (query) => {
        this.#query = query;
      },
    ));
  }

  #prepare(record: ImportRecord, explicitMode: ts.ResolutionMode) {
    const context = this.#createBoundedContext();
    if (this.#query === undefined)
      throw new Error(
        context.nativeEvidence?.failures[0]?.detail ??
          `Bounded TypeScript Program could not resolve ${record.filePath}.`,
      );
    return this.#query(record, explicitMode);
  }

  #raw(record: ImportRecord, explicitMode: ts.ResolutionMode) {
    const native = this.#native;
    if (!native?.hasSourceFile(record.filePath))
      throw new Error(
        native?.nativeEvidence?.failures[0]?.detail ??
          `Bounded TypeScript Program did not admit ${record.filePath}.`,
      );
    return this.#receipts.resolve(
      record,
      explicitMode,
      () => this.#prepare(record, explicitMode),
      native,
    );
  }

  getNativeContext(
    shared: TypeScriptSemanticDependencyContext | undefined,
  ): TypeScriptSemanticDependencyContext {
    return (this.#native ??=
      shared ??
      restoreCollectionContext(this.#request) ??
      this.#createBoundedContext());
  }

  getResolution(record: ImportRecord): RuntimeSourceResolution | undefined {
    return this.#results.get(createImportRecordIdentity(record));
  }

  resolve(
    record: ImportRecord,
    explicitMode: ts.ResolutionMode,
  ): RuntimeSourceResolution | undefined {
    if (!isModuleImportRecord(record)) return undefined;
    const existing = this.getResolution(record);
    if (existing !== undefined) return existing;
    const raw = this.#raw(record, explicitMode);
    const resolved = raw.resolvedModule;
    const target =
      resolved === undefined
        ? null
        : {
            resolvedBy: 'typescript' as const,
            resolvedFileName: normalizeAbsolutePath(resolved.resolvedFileName),
            isExternalLibraryImport: resolved.isExternalLibraryImport === true,
            resolutionOrigin: getResolutionOrigin(resolved),
          };
    const result: RuntimeSourceResolution = {
      mode: raw.runtimeMode ?? undefined,
      target,
    };
    this.#results.set(createImportRecordIdentity(record), result);
    return result;
  }

  releaseProgram(): void {
    this.#query = undefined;
    this.#bounded?.dispose();
    this.#bounded = undefined;
  }
}
