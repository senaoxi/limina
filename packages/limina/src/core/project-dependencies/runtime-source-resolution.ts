import { resolveCheckerSourceModuleName } from '#checkers';
import { normalizeAbsolutePath } from '#utils/path';
import path from 'node:path';
import ts from 'typescript';
import { analysisHash } from '../analysis-cache/identity';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import type { ImportRecord } from '../import-analysis/records';
import { classifyImportRuntimeEvidence } from '../import-analysis/runtime-evidence';
import type { CanonicalImportResolutionEvidence } from '../import-analysis/types';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import { isModuleImportRecord } from '../typescript-semantic/import-record';
import { resolveModuleWithOrigin } from '../typescript-semantic/resolution-origin';
import { withVirtualResolutionFiles } from '../typescript-semantic/virtual-resolution-host';
import type { ProjectSemanticContext } from './contracts';

export interface RuntimeSourceResolution {
  readonly authority: 'runtime-only';
  readonly mode: ts.ResolutionMode;
  readonly evidence: CanonicalImportResolutionEvidence;
}

const NODE_MODULE_RESOLUTIONS = new Set<ts.ModuleResolutionKind>([
  ts.ModuleResolutionKind.Node16,
  ts.ModuleResolutionKind.NodeNext,
]);

const LEGACY_MODULE_KINDS = new Set<ts.ModuleKind>([
  ts.ModuleKind.None,
  ts.ModuleKind.AMD,
  ts.ModuleKind.UMD,
  ts.ModuleKind.System,
]);

function shouldUseResolutionMode(options: ts.CompilerOptions): boolean {
  if (options.resolvePackageJsonExports === true) return true;
  return options.moduleResolution === undefined
    ? options.module === undefined || !LEGACY_MODULE_KINDS.has(options.module)
    : NODE_MODULE_RESOLUTIONS.has(options.moduleResolution) ||
        options.moduleResolution === ts.ModuleResolutionKind.Bundler;
}

function isNodeModuleResolution(options: ts.CompilerOptions): boolean {
  return options.moduleResolution === undefined
    ? [
        ts.ModuleKind.Node16,
        ts.ModuleKind.Node18,
        ts.ModuleKind.Node20,
        ts.ModuleKind.NodeNext,
      ].includes(options.module!)
    : NODE_MODULE_RESOLUTIONS.has(options.moduleResolution);
}

function createResolutionHost(
  virtualFiles: ReadonlyMap<string, string> | undefined,
): ts.ModuleResolutionHost {
  return virtualFiles === undefined || virtualFiles.size === 0
    ? ts.sys
    : withVirtualResolutionFiles(ts.sys, virtualFiles);
}

/**
 * Source/runtime interpretation only; no Program membership, AST retention, or emit proof.
 *
 * Per 0.6.0 semantics, CJS runtime calls (`require`, `require.resolve`, and
 * `createRequire` aliases / `.resolve()`) always resolve under CommonJS (`require`
 * condition) when package-exports resolution modes are active.
 */
export class RuntimeSourceResolver {
  readonly #project: ProjectSemanticContext;
  readonly #analysisCache: NativeAnalysisCache | undefined;
  readonly #optionsId: string;
  readonly #host: ts.ModuleResolutionHost;
  readonly #impliedFormats = new Map<
    string,
    { mode: ts.ResolutionMode; manifests: readonly string[] }
  >();
  readonly #results = new Map<string, RuntimeSourceResolution | undefined>();
  readonly #cache: ts.ModuleResolutionCache;

  constructor(
    project: ProjectSemanticContext,
    analysisCache?: NativeAnalysisCache,
  ) {
    this.#project = project;
    this.#analysisCache =
      (project.virtualFiles?.size ?? 0) === 0 ? analysisCache : undefined;
    this.#optionsId = analysisHash(
      effectiveCompilerOptions(project.compilerOptions),
    );
    this.#host = createResolutionHost(project.virtualFiles);
    this.#cache = ts.createModuleResolutionCache(
      path.dirname(project.configPath),
      (file) => file,
      project.compilerOptions,
    );
  }

  #impliedFormat(file: string): {
    mode: ts.ResolutionMode;
    manifests: readonly string[];
  } {
    const normalized = normalizeAbsolutePath(file);
    const cached = this.#impliedFormats.get(normalized);
    if (cached !== undefined) return cached;
    const manifests: string[] = [];
    const trackingHost: ts.ModuleResolutionHost = {
      ...this.#host,
      fileExists: (filePath) => {
        if (path.basename(filePath) === 'package.json') {
          manifests.push(normalizeAbsolutePath(filePath));
        }
        return this.#host.fileExists(filePath);
      },
      readFile: (filePath) => {
        if (path.basename(filePath) === 'package.json') {
          manifests.push(normalizeAbsolutePath(filePath));
        }
        return this.#host.readFile(filePath);
      },
    };
    const mode = ts.getImpliedNodeFormatForFile(
      normalized as ts.Path,
      undefined,
      trackingHost,
      this.#project.compilerOptions,
    );
    const entry = {
      mode,
      manifests: [...new Set(manifests)],
    };
    this.#impliedFormats.set(normalized, entry);
    return entry;
  }

  #mode(
    record: ImportRecord,
    explicitMode?: ts.ResolutionMode,
  ): { mode: ts.ResolutionMode; formatManifests?: readonly string[] } {
    if (explicitMode !== undefined) return { mode: explicitMode };
    const compilerOptions = this.#project.compilerOptions;
    if (!shouldUseResolutionMode(compilerOptions)) return { mode: undefined };
    if (
      ['commonjs', 'require-resolve', 'import-equals'].includes(record.kind)
    ) {
      return { mode: ts.ModuleKind.CommonJS };
    }
    if (record.kind === 'dynamic') {
      if (isNodeModuleResolution(compilerOptions)) {
        return { mode: ts.ModuleKind.ESNext };
      }
      const implied = this.#impliedFormat(record.filePath);
      return {
        mode: implied.mode ?? ts.ModuleKind.ESNext,
        formatManifests: implied.manifests,
      };
    }
    const implied = this.#impliedFormat(record.filePath);
    if (implied.mode !== undefined) {
      return { mode: implied.mode, formatManifests: implied.manifests };
    }
    return {
      mode: isNodeModuleResolution(compilerOptions)
        ? ts.ModuleKind.CommonJS
        : ts.ModuleKind.ESNext,
      formatManifests: implied.manifests,
    };
  }

  #resolveTypeScriptModule(
    record: ImportRecord,
    mode: ts.ResolutionMode,
    formatManifests: readonly string[] | undefined,
  ): ts.ResolvedModuleFull | undefined {
    const cache = this.#analysisCache;
    if (cache === undefined) {
      return ts.resolveModuleName(
        record.specifier,
        record.filePath,
        this.#project.compilerOptions,
        this.#host,
        this.#cache,
        undefined,
        mode,
      ).resolvedModule;
    }
    const configPath = normalizeAbsolutePath(this.#project.configPath);
    const resolverConfigPath = normalizeAbsolutePath(
      this.#project.resolverConfigPath,
    );
    const configPaths = [
      ...new Set([
        ...(cache.configClosures.get(resolverConfigPath) ?? []),
        ...(cache.configClosures.get(configPath) ?? []),
        configPath,
        resolverConfigPath,
      ]),
    ];
    return cache.queryRuntime({
      contextId: configPath,
      file: normalizeAbsolutePath(record.filePath),
      identity: [
        'runtime-module',
        record.specifier,
        {
          mode: mode ?? null,
          effectiveOptions: this.#optionsId,
          configPaths,
        },
      ],
      configPaths,
      formatManifests,
      host: this.#host,
      resolve: (observed) =>
        resolveModuleWithOrigin(
          ts,
          record.specifier,
          record.filePath,
          this.#project.compilerOptions,
          observed,
          undefined,
          undefined,
          mode,
        ),
    }).resolvedModule;
  }

  #key(record: ImportRecord, explicitMode?: ts.ResolutionMode): string {
    return `${record.filePath}\0${record.kind}\0${record.specifier}\0${explicitMode ?? ''}\0${record.locator.sourceStart}:${record.locator.sourceEnd}:${record.locator.occurrence}`;
  }

  resolve(
    record: ImportRecord,
    explicitMode?: ts.ResolutionMode,
  ): RuntimeSourceResolution | undefined {
    if (!isModuleImportRecord(record)) return undefined;
    const key = this.#key(record, explicitMode);
    if (this.#results.has(key)) return this.#results.get(key);
    const { mode, formatManifests } = this.#mode(record, explicitMode);
    const options = {
      specifier: record.specifier,
      containingFile: record.filePath,
      compilerOptions: this.#project.compilerOptions,
      extensions: [...this.#project.extensions],
    };
    const raw = this.#resolveTypeScriptModule(record, mode, formatManifests);
    const target =
      raw === undefined
        ? resolveCheckerSourceModuleName(options)
        : {
            resolvedBy: 'typescript' as const,
            resolvedFileName: normalizeAbsolutePath(raw.resolvedFileName),
            isExternalLibraryImport: raw.isExternalLibraryImport === true,
          };
    const result: RuntimeSourceResolution = {
      authority: 'runtime-only',
      mode,
      evidence: {
        eligibility: {
          kind: 'not-applicable',
          reason:
            'Source/runtime resolution does not establish compilation obligations.',
        },
        oxcResolvedFilePath: null,
        typeScriptResolution: target,
        runtimeEvidence: classifyImportRuntimeEvidence({
          ...options,
          oxcResolvedFilePath: null,
          typeScriptResolution: target,
        }),
      },
    };
    this.#results.set(key, result);
    return result;
  }
}
