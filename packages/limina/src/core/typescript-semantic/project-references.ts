import {
  observeAnalysisRead,
  readAnalysisInput,
  typeScriptDirectoryDescriptor,
} from '#utils/analysis-input';
import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';

function createParseConfigHost(
  tsModule: typeof ts,
  virtualFiles?: ReadonlyMap<string, string>,
): ts.ParseConfigFileHost {
  return {
    fileExists: (fileName) =>
      readAnalysisInput(
        fileName,
        () => tsModule.sys.fileExists(fileName),
        'file',
      ),
    getCurrentDirectory: tsModule.sys.getCurrentDirectory,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      String(diagnostic.messageText);
    },
    readDirectory: (...arguments_) => {
      const read = () => tsModule.sys.readDirectory(...arguments_);
      const value = read();
      observeAnalysisRead({
        path: arguments_[0],
        descriptor: typeScriptDirectoryDescriptor(arguments_),
        key: JSON.stringify(['reference-files', arguments_]),
        value,
        read,
      });
      return value;
    },
    readFile: (fileName) =>
      virtualFiles?.get(normalizeAbsolutePath(fileName)) ??
      readAnalysisInput(
        fileName,
        () => tsModule.sys.readFile(fileName),
        'typescript-content',
      ),
    useCaseSensitiveFileNames: tsModule.sys.useCaseSensitiveFileNames,
  };
}

export function parseTypeScriptProjectConfig(options: {
  configPath: string;
  tsModule: typeof ts;
  virtualFiles?: ReadonlyMap<string, string>;
}): ts.ParsedCommandLine | undefined {
  return options.tsModule.getParsedCommandLineOfConfigFile(
    options.configPath,
    undefined,
    createParseConfigHost(options.tsModule, options.virtualFiles),
  );
}

function getOutputFileNames(
  commandLine: ts.ParsedCommandLine,
  tsModule: typeof ts,
): string[] {
  return commandLine.fileNames.flatMap((fileName) =>
    tsModule.getOutputFileNames(
      commandLine,
      fileName,
      !tsModule.sys.useCaseSensitiveFileNames,
    ),
  );
}

function collectReferencedCommandLineFiles(options: {
  commandLine: ts.ParsedCommandLine;
  collected: Set<string>;
  tsModule: typeof ts;
  virtualFiles?: ReadonlyMap<string, string>;
  visitedConfigs: Set<string>;
}): void {
  addCommandLineInputs(options);
  addCommandLineOutputs(options);
  collectProjectReferenceFiles({
    collected: options.collected,
    references: options.commandLine.projectReferences ?? [],
    tsModule: options.tsModule,
    virtualFiles: options.virtualFiles,
    visitedConfigs: options.visitedConfigs,
  });
}

function addCommandLineInputs(options: {
  commandLine: ts.ParsedCommandLine;
  collected: Set<string>;
}): void {
  for (const fileName of options.commandLine.fileNames) {
    options.collected.add(normalizeAbsolutePath(fileName));
  }
}

function addCommandLineOutputs(options: {
  commandLine: ts.ParsedCommandLine;
  collected: Set<string>;
  tsModule: typeof ts;
  virtualFiles?: ReadonlyMap<string, string>;
}): void {
  for (const fileName of getOutputFileNames(
    options.commandLine,
    options.tsModule,
  )) {
    options.collected.add(normalizeAbsolutePath(fileName));
  }
}

function collectProjectReference(options: {
  collected: Set<string>;
  reference: ts.ProjectReference;
  tsModule: typeof ts;
  virtualFiles?: ReadonlyMap<string, string>;
  visitedConfigs: Set<string>;
}): void {
  const configPath = normalizeAbsolutePath(
    options.tsModule.resolveProjectReferencePath(options.reference),
  );
  if (options.visitedConfigs.has(configPath)) return;
  options.visitedConfigs.add(configPath);
  const commandLine = parseTypeScriptProjectConfig({
    configPath,
    tsModule: options.tsModule,
    virtualFiles: options.virtualFiles,
  });
  if (commandLine === undefined) return;
  collectReferencedCommandLineFiles({ ...options, commandLine });
}

function collectProjectReferenceFiles(options: {
  collected: Set<string>;
  references: readonly ts.ProjectReference[];
  tsModule: typeof ts;
  virtualFiles?: ReadonlyMap<string, string>;
  visitedConfigs: Set<string>;
}): void {
  for (const reference of options.references) {
    collectProjectReference({ ...options, reference });
  }
}

export function getProjectReferenceSemanticFiles(options: {
  references: readonly ts.ProjectReference[];
  tsModule: typeof ts;
  virtualFiles?: ReadonlyMap<string, string>;
}): string[] {
  const collected = new Set<string>();
  collectProjectReferenceFiles({
    collected,
    references: options.references,
    tsModule: options.tsModule,
    virtualFiles: options.virtualFiles,
    visitedConfigs: new Set(),
  });
  return [...collected];
}
