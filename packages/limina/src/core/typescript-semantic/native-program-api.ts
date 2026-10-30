import type ts from 'typescript';
import {
  isSupportedDependencyVersion,
  liminaRuntimeDependencyContracts,
} from '../../dependency-contract';
import { NativeObservationError } from './native-observation-failure';

export const NATIVE_PROGRAM_ADAPTER = 'bounded-program-ts5.4-6.0-v11';

/**
 * Internal observations adapted across TypeScript 5.4–5.9 and 6.0. No collector,
 * resolution algorithm or checker is implemented here. Unsupported tuples
 * fail explicitly rather than switching discovery authorities.
 */
export interface NativeProgramSource extends ts.SourceFile {
  imports: readonly ts.StringLiteralLike[];
  moduleAugmentations: readonly (ts.StringLiteral | ts.Identifier)[];
  ambientModuleNames: readonly string[];
}

export interface NativeObservedProgram extends ts.Program {
  getSourceFileFromReference(
    source: ts.SourceFile,
    reference: ts.FileReference,
  ): ts.SourceFile | undefined;
  getResolvedModule(
    file: ts.SourceFile,
    name: string,
    mode: ts.ResolutionMode,
  ): ts.ResolvedModuleWithFailedLookupLocations | undefined;
  getCompilerOptionsForFile(
    file: ts.SourceFile,
  ): ts.CompilerOptions | undefined;
  getResolvedTypeReferenceDirective(
    file: ts.SourceFile,
    name: string,
    mode: ts.ResolutionMode,
  ): ts.ResolvedTypeReferenceDirectiveWithFailedLookupLocations | undefined;
  resolvedLibReferences?: ReadonlyMap<
    string,
    { actual: string; resolution: ts.ResolvedModuleWithFailedLookupLocations }
  >;
}

export interface NativeLibraryHost extends ts.CompilerHost {
  resolveLibrary(
    libraryName: string,
    resolveFrom: string,
    options: ts.CompilerOptions,
    libraryFileName: string,
  ): ts.ResolvedModuleWithFailedLookupLocations;
}

interface NativeCompilerApi {
  getJSXImplicitImportBase(
    options: ts.CompilerOptions,
    file: ts.SourceFile,
  ): string | undefined;
  getJSXRuntimeImport(
    base: string | undefined,
    options: ts.CompilerOptions,
  ): string | undefined;
  getResolutionDiagnostic(
    options: ts.CompilerOptions,
    resolution: ts.ResolvedModuleFull,
    source: Pick<ts.SourceFile, 'isDeclarationFile'>,
  ): ts.DiagnosticMessage | undefined;
  getAllowJSCompilerOption(options: ts.CompilerOptions): boolean;
  resolutionExtensionIsTSOrJson(extension: string): boolean;
  isInJSFile(node: ts.Node): boolean;
  resolveLibrary(
    name: string,
    from: string,
    options: ts.CompilerOptions,
    host: ts.ModuleResolutionHost,
    cache: ts.ModuleResolutionCache,
  ): ts.ResolvedModuleWithFailedLookupLocations;
  getModeForFileReference(
    reference: ts.FileReference | string,
    containingFileMode: ts.ResolutionMode,
  ): ts.ResolutionMode;
}

export function nativeCompilerApi(compiler: typeof ts): NativeCompilerApi {
  assertNativeProgramCompiler(compiler);
  const api = compiler as unknown as NativeCompilerApi;
  if (
    [
      'resolveLibrary',
      'getJSXImplicitImportBase',
      'getJSXRuntimeImport',
      'getModeForFileReference',
      'getResolutionDiagnostic',
      'getAllowJSCompilerOption',
      'resolutionExtensionIsTSOrJson',
      'isInJSFile',
    ].some((key) => typeof api[key as keyof NativeCompilerApi] !== 'function')
  )
    throw new NativeObservationError(
      'unsupported',
      'Native compiler observation APIs unavailable.',
    );
  return api;
}

/** The compiler changed type-reference cache modes independently of module
 * requests. Use its actual worker when exposed; older compilers key these
 * references directly by the source's implied format. */
export function nativeTypeReferenceMode(
  compiler: typeof ts,
  reference: ts.FileReference | string,
  source: ts.SourceFile | undefined,
  options: ts.CompilerOptions | undefined,
): ts.ResolutionMode {
  const worker = (
    compiler as typeof ts & {
      getDefaultResolutionModeForFileWorker?: (
        source: ts.SourceFile,
        options: ts.CompilerOptions,
      ) => ts.ResolutionMode;
    }
  ).getDefaultResolutionModeForFileWorker;
  const mode =
    source !== undefined && worker !== undefined && options !== undefined
      ? worker(source, options)
      : source?.impliedNodeFormat;
  return nativeCompilerApi(compiler).getModeForFileReference(reference, mode);
}

export function assertNativeProgramCompiler(compiler: typeof ts): void {
  if (
    !isSupportedDependencyVersion({
      contract: liminaRuntimeDependencyContracts.typescript,
      version: compiler.version,
    })
  )
    throw new NativeObservationError(
      'unsupported',
      `Native Program observations unavailable for TypeScript ${compiler.version}.`,
    );
}

export function nativeProgramSource(file: ts.SourceFile): NativeProgramSource {
  const source = file as NativeProgramSource;
  if (
    [
      source.imports,
      source.moduleAugmentations,
      source.ambientModuleNames,
    ].some((value) => !Array.isArray(value))
  )
    throw new NativeObservationError(
      'unsupported',
      `Incomplete compiler request inventory: ${file.fileName}`,
    );
  return source;
}

export function nativeObservedProgram(
  program: ts.Program,
  compiler: typeof ts,
  optionsBySource: ReadonlyMap<ts.SourceFile, ts.CompilerOptions>,
): NativeObservedProgram {
  const observed = adaptFileOptions(program, compiler, optionsBySource);
  if (
    [
      'getResolvedModule',
      'getSourceFileFromReference',
      'getCompilerOptionsForFile',
      'getResolvedTypeReferenceDirective',
    ].some(
      (key) =>
        typeof observed[key as keyof NativeObservedProgram] !== 'function',
    )
  )
    throw new NativeObservationError(
      'unsupported',
      'Native Program resolution inventory unavailable.',
    );
  return observed;
}

function adaptFileOptions(
  program: ts.Program,
  compiler: typeof ts,
  optionsBySource: ReadonlyMap<ts.SourceFile, ts.CompilerOptions>,
): NativeObservedProgram {
  if (!/^5\.[45]\./.test(compiler.version))
    return program as NativeObservedProgram;
  // 5.4/5.5 supply the actual redirect to resolution callbacks instead of
  // exposing getCompilerOptionsForFile. Preserve those compiler observations.
  const facade = Object.create(program) as NativeObservedProgram;
  // Even a root may be a referenced declaration with different options. A
  // missing callback receipt cannot be replaced by the consumer's defaults.
  facade.getCompilerOptionsForFile = (file) => optionsBySource.get(file);
  return facade;
}
