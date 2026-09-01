import type ts from 'typescript';
import type { TypeScriptInclusionLedger } from './admission';
import type { HostLibraryResolutionInput } from './host';

type RawTypeScriptLibraryResolver = (
  ...args: [
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
  admission: TypeScriptInclusionLedger;
  cache: ts.ModuleResolutionCache;
  host: ts.ModuleResolutionHost;
  input: HostLibraryResolutionInput;
  tsModule: typeof ts;
}): ts.ResolvedModuleWithFailedLookupLocations {
  const resolveLibrary = getLibraryResolver(options.tsModule);
  const result = resolveLibrary(
    options.input.libraryName,
    options.input.resolveFrom,
    options.input.compilerOptions,
    options.host,
    options.cache,
  );
  const target = result.resolvedModule?.resolvedFileName;
  if (target !== undefined) options.admission.addResolvedLibrary(target);
  return result;
}
