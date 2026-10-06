import type ts from 'typescript';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import type { TypeScriptInclusionLedger } from './admission';
import type { HostLibraryResolutionInput } from './host';

type RawTypeScriptLibraryResolver = (
  ...arguments_: [
    libraryName: string,
    resolveFrom: string,
    compilerOptions: ts.CompilerOptions,
    host: ts.ModuleResolutionHost,
    cache: ts.ModuleResolutionCache,
  ]
) => ts.ResolvedModuleWithFailedLookupLocations;

function getLibraryResolver(tsModule: typeof ts): RawTypeScriptLibraryResolver {
  const resolver = (
    tsModule as unknown as {
      resolveLibrary?: RawTypeScriptLibraryResolver;
    }
  ).resolveLibrary;
  if (resolver !== undefined) return resolver;
  throw new Error('Installed TypeScript does not expose library resolution.');
}

export function resolveTypeScriptLibrary(options: {
  analysisCache?: NativeAnalysisCache;
  analysisContextId?: string;
  admission: TypeScriptInclusionLedger;
  cache: ts.ModuleResolutionCache;
  host: ts.ModuleResolutionHost;
  input: HostLibraryResolutionInput;
  tsModule: typeof ts;
}): ts.ResolvedModuleWithFailedLookupLocations {
  const resolveLibrary = getLibraryResolver(options.tsModule);
  const resolve = (host: ts.ModuleResolutionHost) =>
    resolveLibrary(
      options.input.libraryName,
      options.input.resolveFrom,
      options.input.compilerOptions,
      host,
      libraryCache(options),
    );
  const result =
    options.analysisCache === undefined
      ? resolve(options.host)
      : options.analysisCache.query({
          contextId: options.analysisContextId!,
          file: options.input.resolveFrom,
          identity: [
            'lib',
            options.input.libraryName,
            options.input.libFileName,
            options.input.compilerOptions,
          ],
          host: options.host,
          resolve,
        });
  admitLibrary(options.admission, result);
  return result;
}

function libraryCache(
  options: Parameters<typeof resolveTypeScriptLibrary>[0],
): ts.ModuleResolutionCache {
  return options.analysisCache === undefined
    ? options.cache
    : options.tsModule.createModuleResolutionCache(
        options.tsModule.sys.getCurrentDirectory(),
        (file) => file,
        options.input.compilerOptions,
      );
}

function admitLibrary(
  admission: TypeScriptInclusionLedger,
  result: ts.ResolvedModuleWithFailedLookupLocations,
): void {
  const target = result.resolvedModule?.resolvedFileName;
  if (target !== undefined) admission.addResolvedLibrary(target);
}
