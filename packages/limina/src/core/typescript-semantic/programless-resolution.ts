import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import ts from 'typescript';
import { nativeContextId } from '../analysis-cache/identity';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import type { ImportRecord } from '../import-analysis/records';
import type {
  TypeScriptSemanticProject,
  TypeScriptSemanticResolution,
} from './contracts';
import { createTypeScriptResolutionIdentity } from './identity';
import {
  type FileModuleContext,
  nativeRequestApi,
  observeFileModuleContext,
} from './native-request-api';
import { observedResolutionHost } from './observed-resolution-host';
import { createMissingSemanticResolution } from './resolution';
function resolutionChannel(
  record: ImportRecord,
): TypeScriptSemanticResolution['channel'] {
  const channels: Partial<
    Record<ImportRecord['kind'], TypeScriptSemanticResolution['channel']>
  > = {
    'triple-slash-path': 'triple-slash-path',
    'triple-slash-types': 'triple-slash-types',
    'jsx-import-source': 'jsx-runtime',
    'environment-pragma': 'environment-pragma',
  };
  return channels[record.kind] ?? 'module';
}
function normalizedTarget(
  file: string | undefined,
): TypeScriptSemanticResolution['target'] {
  return file === undefined
    ? null
    : {
        resolvedFileName: normalizeAbsolutePath(file),
        resolvedBy: 'typescript',
        isExternalLibraryImport: false,
      };
}
function moduleTarget(
  raw: ts.ResolvedModuleWithFailedLookupLocations,
): TypeScriptSemanticResolution['target'] {
  const module = raw.resolvedModule;
  if (module === undefined) return null;
  return {
    ...normalizedTarget(module.resolvedFileName)!,
    isExternalLibraryImport: module.isExternalLibraryImport === true,
  };
}
export class ProgramlessResolution {
  readonly host: ts.ModuleResolutionHost;
  readonly contextId: string;
  readonly project: TypeScriptSemanticProject;
  readonly identity: string;
  readonly cache: NativeAnalysisCache | undefined;
  constructor(
    project: TypeScriptSemanticProject,
    identity: string,
    cache?: NativeAnalysisCache,
  ) {
    this.project = project;
    this.identity = identity;
    this.cache = cache;
    this.contextId = nativeContextId(project);
    this.host = observedResolutionHost(ts, project.configPath);
  }
  #libraryReplacement(filename: string, fallback: string): string {
    const libraryName =
      nativeRequestApi.getLibraryNameFromLibFileName(filename);
    const from = path.join(
      path.dirname(this.project.configPath),
      `__lib_node_modules_lookup_${filename}__.ts`,
    );
    const resolveLibrary = (
      ts as unknown as { resolveLibrary: typeof ts.resolveModuleName }
    ).resolveLibrary;
    return (
      this.query(from, ['library', libraryName, this.project.options], (host) =>
        resolveLibrary(libraryName, from, this.project.options, host),
      ).resolvedModule?.resolvedFileName ?? fallback
    );
  }
  #module(
    record: ImportRecord,
    mode: ts.ResolutionMode,
  ): TypeScriptSemanticResolution['target'] {
    const raw = this.query(
      record.filePath,
      ['module', record.specifier, mode, this.project.options],
      (host) =>
        ts.resolveModuleName(
          record.specifier,
          record.filePath,
          this.project.options,
          host,
          undefined,
          undefined,
          mode,
        ),
    );
    return moduleTarget(raw);
  }
  #path(record: ImportRecord): TypeScriptSemanticResolution['target'] {
    const raw = this.query(
      record.filePath,
      ['path', record.specifier, this.project.options],
      (host) => {
        const file = ts.resolveTripleslashReference(
          record.specifier,
          record.filePath,
        );
        return {
          resolvedModule: host.fileExists(file)
            ? {
                resolvedFileName: file,
                extension: ts.Extension.Dts,
                isExternalLibraryImport: false,
              }
            : undefined,
          failedLookupLocations: [file],
          affectingLocations: [],
        };
      },
    );
    return moduleTarget(raw);
  }
  #target(
    record: ImportRecord,
    mode: ts.ResolutionMode,
  ): TypeScriptSemanticResolution['target'] {
    if (record.kind === 'triple-slash-types')
      return normalizedTarget(
        this.typeTarget(record.specifier, record.filePath, mode),
      );
    return record.kind === 'triple-slash-path'
      ? this.#path(record)
      : this.#module(record, mode);
  }
  query<T>(
    file: string,
    identity: unknown,
    resolve: (host: ts.ModuleResolutionHost) => T,
  ): T {
    return this.cache === undefined
      ? resolve(this.host)
      : this.cache.query({
          contextId: this.contextId,
          file,
          identity,
          host: this.host,
          resolve,
        });
  }
  format(file: string): FileModuleContext {
    return this.query(
      file,
      ['file-module-context', this.project.options],
      (host) => ({
        ...observeFileModuleContext(file, this.project.options, host),
        failedLookupLocations: [],
        affectingLocations: [],
      }),
    );
  }
  typeNames(): string[] {
    return this.query(
      this.project.configPath,
      ['config-type-directives', this.project.options],
      (host) => ({
        names: ts.getAutomaticTypeDirectiveNames(this.project.options, host),
        failedLookupLocations: [],
        affectingLocations: [],
      }),
    ).names;
  }
  typeTarget(
    name: string,
    file: string,
    mode?: ts.ResolutionMode,
  ): string | undefined {
    return this.query(
      file,
      ['type', name, mode, this.project.options],
      (host) =>
        ts.resolveTypeReferenceDirective(
          name,
          file,
          this.project.options,
          host,
          undefined,
          undefined,
          mode,
        ),
    ).resolvedTypeReferenceDirective?.resolvedFileName;
  }
  library(name: string): string {
    const filename = name.startsWith('lib.')
      ? name
      : `lib.${name.toLowerCase()}.d.ts`;
    const fallback = path.join(
      path.dirname(ts.getDefaultLibFilePath(this.project.options)),
      filename,
    );
    return this.project.options.libReplacement
      ? this.#libraryReplacement(filename, fallback)
      : fallback;
  }
  resolve(
    record: ImportRecord,
    mode: ts.ResolutionMode,
  ): TypeScriptSemanticResolution {
    const channel = resolutionChannel(record);
    if (['environment-pragma', 'jsdoc-import'].includes(record.kind))
      return createMissingSemanticResolution({
        channel,
        contextIdentity: this.identity,
        importRecord: record,
      });
    return {
      channel,
      identity: createTypeScriptResolutionIdentity({
        contextIdentity: this.identity,
        importRecord: record,
        redirectedReferenceIdentity: null,
        resolutionMode: mode,
      }),
      redirectedReferenceIdentity: null,
      resolutionMode: mode,
      target: this.#target(record, mode),
    };
  }
}
