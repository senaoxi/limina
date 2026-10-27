import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import type ts from 'typescript';
import { analysisHash } from '../analysis-cache/identity';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { nativeLibraryFileNames } from './native-library-api';
import {
  nativeCompilerApi,
  type NativeLibraryHost,
  type NativeObservedProgram,
} from './native-program-api';
import { observedResolutionHost } from './observed-resolution-host';
import { withVirtualResolutionFiles } from './virtual-resolution-host';

export interface LibrarySelection {
  fileName: string;
  libraryName: string;
  target: string;
  replacement: boolean;
}
export interface LibrarySelectionInput {
  kind: 'source' | 'projection';
  compiler: typeof ts;
  configPath: string;
  libReplacement: boolean | undefined;
  cache?: NativeAnalysisCache;
  files?: ReadonlyMap<string, string>;
}

function resolveLibrary(
  input: LibrarySelectionInput,
  host: ts.ModuleResolutionHost,
  request: Parameters<NativeLibraryHost['resolveLibrary']>,
): ts.ResolvedModuleWithFailedLookupLocations {
  const [name, from, options] = request;
  const resolve = (host: ts.ModuleResolutionHost) =>
    nativeCompilerApi(input.compiler).resolveLibrary(
      name,
      from,
      options,
      host,
      input.compiler.createModuleResolutionCache(
        path.dirname(from),
        (file) => file,
      ),
    );
  return input.kind === 'projection' ||
    input.cache === undefined ||
    input.files?.size
    ? resolve(host)
    : input.cache.query({
        contextId: analysisHash(['library-selection', input.compiler.version]),
        file: input.configPath,
        identity: { name, from, libReplacement: input.libReplacement },
        retain: true,
        host,
        resolve,
      });
}

/**
 * Query the compiler's finite library catalog, not a source dependency graph.
 * Replacement resolution depends on config location and libReplacement; TS
 * supplies its version-specific default, library names, and fallback targets.
 * No library or user source is loaded, checked, or promoted into Native facts.
 */
export function collectLibrarySelections(
  input: LibrarySelectionInput,
): LibrarySelection[] {
  const { compiler, configPath } = input;
  const probe = path.join(path.dirname(configPath), '__library_selection__.ts');
  const options: ts.CompilerOptions = {
    configFilePath: configPath,
    libReplacement: input.libReplacement,
    lib: nativeLibraryFileNames(compiler),
    types: [],
  };
  const names = new Map<string, string>();
  // Source reads establish freshness. Candidate reads are revalidated against
  // staged/materialized bindings, not retained as pre-materialization FS facts.
  const host = withVirtualResolutionFiles(
    input.kind === 'source'
      ? observedResolutionHost(compiler, configPath)
      : {
          ...compiler.sys,
          getCurrentDirectory: () => path.dirname(configPath),
        },
    input.files,
  );
  const compilerHost: NativeLibraryHost = {
    ...compiler.createCompilerHost(options),
    ...host,
    useCaseSensitiveFileNames: () => compiler.sys.useCaseSensitiveFileNames,
    getSourceFile: (file) =>
      file === probe
        ? compiler.createSourceFile(file, '', compiler.ScriptTarget.Latest)
        : undefined,
    resolveLibrary: (...request) => {
      names.set(request[3], request[0]);
      return resolveLibrary(input, host, request);
    },
  };
  const program = compiler.createProgram({
    rootNames: [probe],
    options,
    host: compilerHost,
  }) as NativeObservedProgram;
  return [...names].map(([fileName, libraryName]) => {
    const selection = program.resolvedLibReferences?.get(fileName);
    if (selection === undefined)
      throw new Error(`Compiler library selection unavailable: ${fileName}`);
    return {
      fileName,
      libraryName,
      target: normalizeAbsolutePath(selection.actual),
      replacement: selection.resolution.resolvedModule !== undefined,
    };
  });
}
