import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';

function createParseConfigHost(tsModule: typeof ts): ts.ParseConfigFileHost {
  return {
    fileExists: tsModule.sys.fileExists,
    getCurrentDirectory: tsModule.sys.getCurrentDirectory,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      String(diagnostic.messageText);
    },
    readDirectory: tsModule.sys.readDirectory,
    readFile: tsModule.sys.readFile,
    useCaseSensitiveFileNames: tsModule.sys.useCaseSensitiveFileNames,
  };
}

export function parseTypeScriptProjectConfig(options: {
  configPath: string;
  tsModule: typeof ts;
}): ts.ParsedCommandLine | undefined {
  return options.tsModule.getParsedCommandLineOfConfigFile(
    options.configPath,
    undefined,
    createParseConfigHost(options.tsModule),
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
  visitedConfigs: Set<string>;
}): void {
  addCommandLineInputs(options);
  addCommandLineOutputs(options);
  collectProjectReferenceFiles({
    collected: options.collected,
    references: options.commandLine.projectReferences ?? [],
    tsModule: options.tsModule,
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
  });
  if (commandLine === undefined) return;
  collectReferencedCommandLineFiles({ ...options, commandLine });
}

function collectProjectReferenceFiles(options: {
  collected: Set<string>;
  references: readonly ts.ProjectReference[];
  tsModule: typeof ts;
  visitedConfigs: Set<string>;
}): void {
  for (const reference of options.references) {
    collectProjectReference({ ...options, reference });
  }
}

export function getProjectReferenceSemanticFiles(options: {
  references: readonly ts.ProjectReference[];
  tsModule: typeof ts;
}): string[] {
  const collected = new Set<string>();
  collectProjectReferenceFiles({
    collected,
    references: options.references,
    tsModule: options.tsModule,
    visitedConfigs: new Set(),
  });
  return [...collected];
}
