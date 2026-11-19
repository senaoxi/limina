import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import { analysisHash, nativeContextId } from '../analysis-cache/identity';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { effectiveCompilerOptions } from './compiler-options';
import type { TypeScriptSemanticProject } from './contracts';
import type { NativeProgramFrontier } from './native-program-frontier';
export interface CallbackRequest {
  channel: 'module' | 'type' | 'library';
  name: string;
  file: string;
  effective: ts.CompilerOptions;
  mode?: ts.ResolutionMode;
  redirect?: ts.ResolvedProjectReference;
  source?: ts.SourceFile;
}

export class BoundedResolutionQueries {
  readonly #cache: NativeAnalysisCache;
  readonly #contextId: string;
  readonly #ownerClosure: readonly string[];
  readonly #closures = new WeakMap<
    ts.CompilerOptions,
    Map<ts.ResolvedProjectReference | undefined, string[]>
  >();
  readonly #sources = new WeakMap<ts.SourceFile, string>();
  readonly #options = new WeakMap<ts.CompilerOptions, string>();
  readonly ids: Set<string> = new Set<string>();
  constructor(cache: NativeAnalysisCache, project: TypeScriptSemanticProject) {
    this.#cache = cache;
    this.#contextId = nativeContextId(project);
    const owner = project.sourceConfigPath ?? project.configPath;
    this.#ownerClosure = cache.authorities[owner]?.closure ?? [owner];
  }
  #sourceVersion(source: ts.SourceFile | undefined): string | null {
    if (source === undefined) return null;
    let version = this.#sources.get(source);
    if (version === undefined) {
      const inputs = this.#cache.inputs;
      version = analysisHash([
        analysisHash(source.text),
        inputs.observe(source.fileName, 'content').expectedVersion,
        inputs.observe(source.fileName, 'binding').expectedVersion,
      ]);
      this.#cache.increment('resolutionSourceHashes');
      this.#sources.set(source, version);
    }
    return version;
  }
  #optionsId(options: ts.CompilerOptions): string {
    let id = this.#options.get(options);
    if (id === undefined) {
      id = analysisHash(effectiveCompilerOptions(options));
      this.#options.set(options, id);
    }
    return id;
  }
  #configPaths(request: CallbackRequest): string[] {
    const byRedirect =
      this.#closures.get(request.effective) ??
      new Map<ts.ResolvedProjectReference | undefined, string[]>();
    const prior = byRedirect.get(request.redirect);
    if (prior !== undefined) return prior;
    const configPaths = [
      ...new Set([
        ...this.#ownerClosure,
        ...((request.effective.configFile as ts.TsConfigSourceFile | undefined)
          ?.extendedSourceFiles ?? []),
        ...(request.redirect
          ? [
              request.redirect.sourceFile.fileName,
              ...((request.redirect.sourceFile as ts.TsConfigSourceFile)
                .extendedSourceFiles ?? []),
            ]
          : []),
      ]),
    ];
    byRedirect.set(request.redirect, configPaths);
    this.#closures.set(request.effective, byRedirect);
    return configPaths;
  }
  resolve<T>(
    host: ts.ModuleResolutionHost,
    request: CallbackRequest,
    frontier: NativeProgramFrontier,
    resolve: (host: ts.ModuleResolutionHost) => T,
  ): T {
    const redirected = request.redirect?.commandLine.options;
    const configPaths = this.#configPaths(request);
    const identity = [
      request.channel,
      request.name,
      request.mode ?? null,
      this.#optionsId(request.effective),
      redirected ? this.#optionsId(redirected) : null,
      request.redirect?.sourceFile.fileName ?? null,
      this.#sourceVersion(request.source),
      configPaths,
    ];
    return this.#cache.query({
      contextId: this.#contextId,
      file: normalizeAbsolutePath(request.file),
      identity,
      host,
      resolve,
      receipts: this.ids,
      owners: (target) => {
        const { coverage } = frontier.inspect(target);
        return coverage.completeness === 'complete' &&
          (coverage.state === 'unique' || coverage.state === 'uncovered')
          ? coverage.members.map((member) => member.configId)
          : undefined;
      },
      configPaths,
    });
  }
}
