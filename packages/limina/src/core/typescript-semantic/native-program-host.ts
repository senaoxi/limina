import { normalizeAbsolutePath } from '#utils/path';
import path from 'node:path';
import type ts from 'typescript';
import type {
  BoundedResolutionQueries,
  CallbackRequest,
} from './bounded-resolution-queries';
import type { TypeScriptSemanticProject } from './contracts';
import {
  type NativeHostFailures,
  readNativeSource,
  recordNativeConfigFailure,
} from './native-host-failures';
import { observeNativeHostInputs } from './native-host-inputs';
import {
  nativeCompilerApi,
  type NativeLibraryHost,
  nativeTypeReferenceMode,
} from './native-program-api';
import type { NativeProgramFrontier } from './native-program-frontier';
import type { NativeProgramLoads } from './native-program-loads';
import type { NativeProgramRequests } from './native-program-requests';
import { parseTypeScriptProjectConfig } from './project-references';
import {
  resolveModuleWithOrigin,
  resolveTypeWithOrigin,
} from './resolution-origin';
import { withVirtualResolutionFiles } from './virtual-resolution-host';

export interface NativeProgramHost extends ts.CompilerHost {
  resolveRuntimeModule(
    request: ModuleQuery,
    host: ts.ModuleResolutionHost,
  ): ts.ResolvedModuleWithFailedLookupLocations;
}

interface ModuleQuery {
  file: string;
  name: string;
  mode: ts.ResolutionMode;
  effective: ts.CompilerOptions;
  redirect: ts.ResolvedProjectReference | undefined;
}

interface HostInputs extends NativeHostFailures {
  queries?: BoundedResolutionQueries;
  loads: NativeProgramLoads;
  project: TypeScriptSemanticProject;
  compiler: typeof ts;
  frontier: NativeProgramFrontier;
  requests: NativeProgramRequests;
  configReads: string[];
  collectSyntaxParents?: boolean;
  syntaxFiles?: ReadonlySet<string>;
}

function resolveCallback<T>(
  input: HostInputs,
  host: ts.CompilerHost,
  request: CallbackRequest,
  resolve: (host: ts.ModuleResolutionHost) => T,
): T {
  return input.queries === undefined
    ? resolve(host)
    : input.queries.resolve(host, request, input.frontier, resolve);
}

function attachModuleResolver(
  host: NativeProgramHost,
  input: HostInputs,
  cache: ts.ModuleResolutionCache,
): void {
  host.resolveModuleNameLiterals = (...arguments_) => {
    const [literals, from, redirect, effective, source] = arguments_;
    const sourceOptions = redirect?.commandLine.options ?? effective;
    input.requests.optionsBySource.set(source, sourceOptions);
    return literals.map((literal) => {
      const mode = input.compiler.getModeForUsageLocation(
        source,
        literal,
        sourceOptions,
      );
      const raw = resolveCallback(
        input,
        host,
        {
          channel: 'module',
          file: from,
          name: literal.text,
          mode,
          effective,
          redirect,
          source,
        },
        (observed) =>
          resolveNativeModule(
            input.compiler,
            { file: from, name: literal.text, effective, redirect, mode },
            observed,
            input.queries ? undefined : cache,
          ),
      );
      if (!sourceOptions.noResolve)
        input.loads.resolved(raw.resolvedModule?.resolvedFileName);
      input.requests.moduleCallback({ source, literal, mode, raw, redirect });
      return raw;
    });
  };
}

function resolveNativeModule(
  compiler: typeof ts,
  request: ModuleQuery,
  host: ts.ModuleResolutionHost,
  cache?: ts.ModuleResolutionCache,
) {
  return resolveModuleWithOrigin(
    compiler,
    request.name,
    request.file,
    request.effective,
    host,
    cache,
    request.redirect,
    request.mode,
  );
}

function configuredTypeField(
  reference: ts.FileReference | string,
  options: ts.CompilerOptions,
) {
  const names = options.types ?? [];
  return configuredTypeIndex(reference, names);
}

function configuredTypeIndex(
  reference: ts.FileReference | string,
  names: readonly string[],
) {
  return typeof reference === 'string' && names.includes(reference)
    ? `types[${names.indexOf(reference)}]`
    : undefined;
}

function attachTypeResolver(host: ts.CompilerHost, input: HostInputs): void {
  host.resolveTypeReferenceDirectiveReferences = (...arguments_) => {
    const [references, from, redirect, effective, source] = arguments_;
    recordSourceOptions(input, source, { redirect, effective });
    return references.map((reference) => {
      const mode = nativeTypeReferenceMode(
        input.compiler,
        reference,
        source,
        redirect?.commandLine.options ?? effective,
      );
      const name =
        typeof reference === 'string' ? reference : reference.fileName;
      const raw = resolveCallback(
        input,
        host,
        {
          channel: 'type',
          file: from,
          name,
          mode,
          effective,
          redirect,
          source,
        },
        (observed) =>
          resolveTypeWithOrigin(
            input.compiler,
            name,
            from,
            effective,
            observed,
            redirect,
            undefined,
            mode,
          ),
      );
      grantType(input, raw);
      input.requests.typeCallback({
        reference,
        source,
        mode,
        raw,
        redirect,
        configField: configuredTypeField(reference, effective),
      });
      return raw;
    });
  };
}

function recordSourceOptions(
  input: HostInputs,
  source: ts.SourceFile | undefined,
  options: {
    redirect: ts.ResolvedProjectReference | undefined;
    effective: ts.CompilerOptions;
  },
): void {
  if (source !== undefined)
    input.requests.optionsBySource.set(
      source,
      options.redirect === undefined
        ? options.effective
        : options.redirect.commandLine.options,
    );
}

function attachLibraryResolver(
  host: ts.CompilerHost,
  input: HostInputs,
  cache: ts.ModuleResolutionCache,
): void {
  (host as NativeLibraryHost).resolveLibrary = (...arguments_) => {
    const [name, from, effective, libraryFileName] = arguments_;
    const raw = resolveCallback(
      input,
      host,
      { channel: 'library', file: from, name, effective, libraryFileName },
      (observed) =>
        nativeCompilerApi(input.compiler).resolveLibrary(
          name,
          from,
          effective,
          observed,
          input.queries
            ? input.compiler.createModuleResolutionCache(
                path.dirname(from),
                host.getCanonicalFileName,
                effective,
              )
            : cache,
        ),
    );
    grantLibrary(input, { effective, libraryFileName }, raw);
    input.requests.record({
      position: -1,
      channel: 'library',
      name: libraryFileName,
      target: raw.resolvedModule?.resolvedFileName,
      external: raw.resolvedModule?.isExternalLibraryImport,
      redirects: [name],
    });
    return raw;
  };
}

function referenceConfig(input: HostInputs, configPath: string) {
  input.configReads.push(normalizeAbsolutePath(configPath));
  const parsed = parseTypeScriptProjectConfig({
    configPath,
    tsModule: input.compiler,
    virtualFiles: input.project.virtualFiles,
  });
  const config = parsed?.options.configFile as
    | ts.TsConfigSourceFile
    | undefined;
  if (config?.extendedSourceFiles !== undefined)
    input.configReads.push(...config.extendedSourceFiles);
  recordNativeConfigFailure(input, configPath, parsed);
  return parsed;
}

function isExternalLibrarySource(
  fileName: string,
  defaultLibraryPrefix: string,
): boolean {
  const normalized = normalizeAbsolutePath(fileName);
  return (
    normalized.includes('/node_modules/') ||
    normalized.startsWith(defaultLibraryPrefix)
  );
}

export function createNativeProgramHost(input: HostInputs): NativeProgramHost {
  const base = input.compiler.createCompilerHost(input.project.options);
  // Only physical fallbacks belong to the filesystem epoch. Staged answers
  // are bound to the candidate plan and may materialize during this command.
  observeNativeHostInputs(base);
  applyNativeVirtualInputs(base, input.project.virtualFiles);
  const parentBase =
    input.collectSyntaxParents === true
      ? input.compiler.createCompilerHost(input.project.options, true)
      : undefined;
  if (parentBase !== undefined) {
    parentBase.readFile = base.readFile;
  }
  const defaultLibraryPrefix =
    parentBase === undefined
      ? ''
      : `${normalizeAbsolutePath(
          path.dirname(
            input.compiler.getDefaultLibFilePath(input.project.options),
          ),
        )}/`;
  const sourceHostFor = (fileName: string): ts.CompilerHost =>
    parentBase !== undefined &&
    input.syntaxFiles?.has(normalizeAbsolutePath(fileName)) !== false &&
    !isExternalLibrarySource(fileName, defaultLibraryPrefix)
      ? parentBase
      : base;
  const host: NativeProgramHost = {
    ...base,
    resolveRuntimeModule: (request, resolutionHost) =>
      resolveNativeModule(input.compiler, request, resolutionHost),
    getSourceFile: (...arguments_) =>
      input.loads.allow(arguments_[0])
        ? readNativeSource(input, arguments_[0], () =>
            observeSource(
              input,
              base,
              sourceHostFor(arguments_[0]).getSourceFile(...arguments_),
            ),
          )
        : undefined,
    getParsedCommandLine: (configPath) => referenceConfig(input, configPath),
  };
  if (base.getSourceFileByPath !== undefined)
    host.getSourceFileByPath = (...arguments_) =>
      input.loads.allow(arguments_[0])
        ? readNativeSource(input, arguments_[0], () =>
            observeSource(
              input,
              base,
              (
                sourceHostFor(arguments_[0]).getSourceFileByPath ??
                base.getSourceFileByPath!
              )(...arguments_),
            ),
          )
        : undefined;
  const cache = input.compiler.createModuleResolutionCache(
    path.dirname(input.project.configPath),
    host.getCanonicalFileName,
    input.project.options,
  );
  attachModuleResolver(host, input, cache);
  attachTypeResolver(host, input);
  attachLibraryResolver(host, input, cache);
  return host;
}

function applyNativeVirtualInputs(
  host: ts.CompilerHost,
  files: ReadonlyMap<string, string> | undefined,
): void {
  if (files === undefined) return;
  Object.assign(host, withVirtualResolutionFiles(host, files));
}

function observeSource(
  input: HostInputs,
  host: ts.CompilerHost,
  source: ts.SourceFile | undefined,
) {
  if (source !== undefined) input.loads.source(source, host, input.requests);
  return source;
}

function grantType(
  input: HostInputs,
  raw: ts.ResolvedTypeReferenceDirectiveWithFailedLookupLocations | undefined,
): void {
  input.loads.resolved(raw?.resolvedTypeReferenceDirective?.resolvedFileName);
}
function grantLibrary(
  input: HostInputs,
  library: { effective: ts.CompilerOptions; libraryFileName: string },
  raw: ts.ResolvedModuleWithFailedLookupLocations,
): void {
  const { effective, libraryFileName } = library;
  const directory = path.dirname(
    input.compiler.getDefaultLibFilePath(effective),
  );
  input.loads.grant(
    raw.resolvedModule?.resolvedFileName ??
      path.join(directory, libraryFileName),
  );
}
