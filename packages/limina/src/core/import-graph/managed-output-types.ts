export interface ManagedOutputProjectContext {
  checkerName: string;
  sourceConfigPath: string;
  outputOptions: {
    outDir: string;
    rootDir: string;
  };
  ownedFileNames: readonly string[];
  extensions: readonly string[];
}

export interface ManagedOutputDeclarationProvider {
  checkerNames: readonly string[];
  declarationFilePath: string;
  mappedSourceFilePath: string;
  reason: 'owned-source';
  sourceConfigPath: string;
}

export interface ManagedOutputDeclarationLookup {
  resolve(
    declarationFilePath: string,
    preferredCheckerName?: string,
  ): ManagedOutputDeclarationProvider | null;
}

export interface NormalizedManagedOutputProjectContext {
  checkerName: string;
  sourceConfigPath: string;
  outputOptions: {
    outDir: string;
    rootDir: string;
  };
  ownedFileNames: Set<string>;
  extensions: string[];
}

export interface ManagedOutputMatch {
  checkerName: string;
  declarationFilePath: string;
  mappedSourceFilePath: string;
  sourceConfigPath: string;
}
