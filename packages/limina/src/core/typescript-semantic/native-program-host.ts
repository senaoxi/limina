import { normalizeAbsolutePath } from '#utils/path';
import path from 'node:path';
import type ts from 'typescript';
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
} from './native-program-api';
import type { NativeProgramFrontier } from './native-program-frontier';
import type { NativeProgramLoads } from './native-program-loads';
import type { NativeProgramRequests } from './native-program-requests';
import { parseTypeScriptProjectConfig } from './project-references';
import {
  resolveModuleWithOrigin,
  resolveTypeWithOrigin,
} from './resolution-origin';

interface HostInputs extends NativeHostFailures {
  loads: NativeProgramLoads;
  project: TypeScriptSemanticProject;
  compiler: typeof ts;
  frontier: NativeProgramFrontier;
  requests: NativeProgramRequests;
  configReads: string[];
}

function attachModuleResolver(
  host: ts.CompilerHost,
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
      const raw = resolveModuleWithOrigin(
        input.compiler,
        literal.text,
        from,
        effective,
        host,
        cache,
        redirect,
        mode,
      );
      if (!sourceOptions.noResolve)
        input.loads.resolved(raw.resolvedModule?.resolvedFileName);
      input.requests.moduleCallback({ source, literal, mode, raw, redirect });
      return raw;
    });
  };
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
  const api = nativeCompilerApi(input.compiler);
  host.resolveTypeReferenceDirectiveReferences = (...arguments_) => {
    const [references, from, redirect, effective, source] = arguments_;
    recordSourceOptions(input, source, { redirect, effective });
    return references.map((reference) => {
      const mode = api.getModeForFileReference(
        reference,
        source?.impliedNodeFormat,
      );
      const raw = resolveTypeWithOrigin(
        input.compiler,
        typeof reference === 'string' ? reference : reference.fileName,
        from,
        effective,
        host,
        redirect,
        undefined,
        mode,
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
    const raw = nativeCompilerApi(input.compiler).resolveLibrary(
      name,
      from,
      effective,
      host,
      cache,
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
  recordNativeConfigFailure(input, configPath, parsed);
  return parsed;
}

export function createNativeProgramHost(input: HostInputs): ts.CompilerHost {
  const base = input.compiler.createCompilerHost(input.project.options);
  applyNativeVirtualInputs(base, input.project.virtualFiles);
  observeNativeHostInputs(base);
  const host: ts.CompilerHost = {
    ...base,
    getSourceFile: (...arguments_) =>
      input.loads.allow(arguments_[0])
        ? readNativeSource(input, arguments_[0], () =>
            observeSource(input, base, base.getSourceFile(...arguments_)),
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
              base.getSourceFileByPath!(...arguments_),
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
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.readFile = (file) =>
    files.get(normalizeAbsolutePath(file)) ?? read(file);
  host.fileExists = (file) =>
    files.has(normalizeAbsolutePath(file)) || exists(file);
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
