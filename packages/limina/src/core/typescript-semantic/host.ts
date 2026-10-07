import type ts from 'typescript';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import type { TypeScriptSemanticProject } from './contracts';
import { observeCompilerReads } from './host-observation';
import { parseTypeScriptProjectConfig } from './project-references';
import type { OwnedSyntaxInput, OwnedSyntaxScope } from './syntax-input';

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
    ...arguments_: [
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
  onSourceFile(sourceFile: ts.SourceFile, input?: OwnedSyntaxInput): void;
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
  parserInput: ts.ScriptTarget | ts.CreateSourceFileOptions;
  syntaxScope?: OwnedSyntaxScope;
}): ts.SourceFile | undefined {
  if (!options.callbacks.allowSourceFile(options.fileName)) return undefined;
  const sourceFile = options.create();
  if (sourceFile !== undefined) notifySourceFile(sourceFile, options);
  return sourceFile;
}

function notifySourceFile(
  sourceFile: ts.SourceFile,
  options: Parameters<typeof readSourceFile>[0],
): void {
  options.callbacks.onSourceFile(
    sourceFile,
    options.syntaxScope?.capture(sourceFile, options.parserInput),
  );
}

export function createTypeScriptSemanticHost(options: {
  analysisCache?: NativeAnalysisCache;
  project?: TypeScriptSemanticProject;
  callbacks: TypeScriptSemanticHostCallbacks;
  compilerOptions: ts.CompilerOptions;
  tsModule: typeof ts;
  virtualFiles?: ReadonlyMap<string, string>;
  syntaxScope?: OwnedSyntaxScope;
}): ts.CompilerHost {
  const base = options.tsModule.createCompilerHost(options.compilerOptions);
  observeCompilerReads(base, options.analysisCache, options.project);
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
        virtualFiles: options.virtualFiles,
      }),
    getSourceFile(...arguments_): ts.SourceFile | undefined {
      return readSourceFile({
        callbacks: options.callbacks,
        create: () => base.getSourceFile(...arguments_),
        fileName: arguments_[0],
        parserInput: arguments_[1],
        syntaxScope: options.syntaxScope,
      });
    },
    resolveModuleNameLiterals: (...arguments_) =>
      options.callbacks.resolveModuleNameLiterals({
        compilerOptions: arguments_[3],
        containingFile: arguments_[1],
        literals: arguments_[0],
        redirectedReference: arguments_[2],
        sourceFile: arguments_[4],
      }),
    resolveTypeReferenceDirectiveReferences: (...arguments_) =>
      options.callbacks.resolveTypeReferenceDirectiveReferences({
        compilerOptions: arguments_[3],
        containingFile: arguments_[1],
        redirectedReference: arguments_[2],
        references: arguments_[0],
        sourceFile: arguments_[4],
      }),
  };

  if (base.getSourceFileByPath !== undefined) {
    host.getSourceFileByPath = (...arguments_): ts.SourceFile | undefined =>
      readSourceFile({
        callbacks: options.callbacks,
        create: () => base.getSourceFileByPath!(...arguments_),
        fileName: arguments_[0],
        parserInput: arguments_[2],
        syntaxScope: options.syntaxScope,
      });
  }

  const hostWithLibrary = host as CompilerHostWithLibraryResolution;
  hostWithLibrary.resolveLibrary = (...arguments_) =>
    options.callbacks.resolveLibrary({
      compilerOptions: arguments_[2],
      libFileName: arguments_[3],
      libraryName: arguments_[0],
      resolveFrom: arguments_[1],
    });

  return host;
}
