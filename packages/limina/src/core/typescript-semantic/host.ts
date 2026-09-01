import type ts from 'typescript';
import { parseTypeScriptProjectConfig } from './project-references';

export interface HostModuleResolutionInput {
  compilerOptions: ts.CompilerOptions;
  containingFile: string;
  literals: readonly ts.StringLiteralLike[];
  redirectedReference: ts.ResolvedProjectReference | undefined;
  sourceFile: ts.SourceFile;
}

export interface HostTypeReferenceResolutionInput {
  compilerOptions: ts.CompilerOptions;
  containingFile: string;
  redirectedReference: ts.ResolvedProjectReference | undefined;
  references: readonly (ts.FileReference | string)[];
  sourceFile: ts.SourceFile | undefined;
}

export interface HostLibraryResolutionInput {
  compilerOptions: ts.CompilerOptions;
  libFileName: string;
  libraryName: string;
  resolveFrom: string;
}

type CompilerHostWithLibraryResolution = ts.CompilerHost & {
  resolveLibrary?: (
    ...args: [
      libraryName: string,
      resolveFrom: string,
      compilerOptions: ts.CompilerOptions,
      libFileName: string,
    ]
  ) => ts.ResolvedModuleWithFailedLookupLocations;
};

interface TypeScriptSemanticHostCallbacks {
  allowSourceFile(fileName: string): boolean;
  onDefaultLib(fileName: string): void;
  onSourceFile(sourceFile: ts.SourceFile): void;
  resolveModuleNameLiterals(
    input: HostModuleResolutionInput,
  ): readonly ts.ResolvedModuleWithFailedLookupLocations[];
  resolveLibrary(
    input: HostLibraryResolutionInput,
  ): ts.ResolvedModuleWithFailedLookupLocations;
  resolveTypeReferenceDirectiveReferences(
    input: HostTypeReferenceResolutionInput,
  ): readonly ts.ResolvedTypeReferenceDirectiveWithFailedLookupLocations[];
}

function readSourceFile(options: {
  callbacks: TypeScriptSemanticHostCallbacks;
  create: () => ts.SourceFile | undefined;
  fileName: string;
}): ts.SourceFile | undefined {
  if (!options.callbacks.allowSourceFile(options.fileName)) return undefined;
  const sourceFile = options.create();
  if (sourceFile !== undefined) options.callbacks.onSourceFile(sourceFile);
  return sourceFile;
}

export function createTypeScriptSemanticHost(options: {
  callbacks: TypeScriptSemanticHostCallbacks;
  compilerOptions: ts.CompilerOptions;
  tsModule: typeof ts;
}): ts.CompilerHost {
  const base = options.tsModule.createCompilerHost(options.compilerOptions);
  const host: ts.CompilerHost = {
    ...base,
    getDefaultLibFileName(compilerOptions): string {
      const fileName = base.getDefaultLibFileName(compilerOptions);
      options.callbacks.onDefaultLib(fileName);
      return fileName;
    },
    getParsedCommandLine: (fileName) =>
      parseTypeScriptProjectConfig({
        configPath: fileName,
        tsModule: options.tsModule,
      }),
    getSourceFile(...args): ts.SourceFile | undefined {
      return readSourceFile({
        callbacks: options.callbacks,
        create: () => base.getSourceFile(...args),
        fileName: args[0],
      });
    },
    resolveModuleNameLiterals: (...args) =>
      options.callbacks.resolveModuleNameLiterals({
        compilerOptions: args[3],
        containingFile: args[1],
        literals: args[0],
        redirectedReference: args[2],
        sourceFile: args[4],
      }),
    resolveTypeReferenceDirectiveReferences: (...args) =>
      options.callbacks.resolveTypeReferenceDirectiveReferences({
        compilerOptions: args[3],
        containingFile: args[1],
        redirectedReference: args[2],
        references: args[0],
        sourceFile: args[4],
      }),
  };

  if (base.getSourceFileByPath !== undefined) {
    host.getSourceFileByPath = (...args): ts.SourceFile | undefined =>
      readSourceFile({
        callbacks: options.callbacks,
        create: () => base.getSourceFileByPath!(...args),
        fileName: args[0],
      });
  }

  const hostWithLibrary = host as CompilerHostWithLibraryResolution;
  hostWithLibrary.resolveLibrary = (...args) =>
    options.callbacks.resolveLibrary({
      compilerOptions: args[2],
      libFileName: args[3],
      libraryName: args[0],
      resolveFrom: args[1],
    });

  return host;
}
