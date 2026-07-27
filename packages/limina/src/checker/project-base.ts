import { normalizeAbsolutePath } from '#utils/path';
import ts from 'typescript';
import {
  createExtraFileExtensions,
  normalizeExtensions,
  resolveExtensionsForChecker,
} from './extensions';
import type {
  CheckerProjectConfigParseOptions,
  ParsedCheckerProjectConfig,
} from './types';

export function createProjectParseHost(
  virtualFiles: ReadonlyMap<string, string> | undefined,
): typeof ts.sys {
  if (virtualFiles === undefined) return ts.sys;
  return {
    ...ts.sys,
    fileExists(fileName): boolean {
      if (virtualFiles.has(normalizeAbsolutePath(fileName))) return true;
      return ts.sys.fileExists(fileName);
    },
    readFile(fileName, encoding): string | undefined {
      const content = virtualFiles.get(normalizeAbsolutePath(fileName));
      if (content !== undefined) return content;
      return ts.sys.readFile(fileName, encoding);
    },
  };
}

export function createFormatHost(rootDir: string): ts.FormatDiagnosticsHost {
  return {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => rootDir,
    getNewLine: () => '\n',
  };
}

function requireParsedCommandLine(options: {
  diagnostics: readonly ts.Diagnostic[];
  parsed: ts.ParsedCommandLine | undefined;
  projectRootDir: string;
}): ts.ParsedCommandLine {
  if (options.parsed !== undefined) return options.parsed;
  throw new Error(
    ts.formatDiagnosticsWithColorAndContext(
      options.diagnostics,
      createFormatHost(options.projectRootDir),
    ),
  );
}

function assertNoParseErrors(options: {
  diagnostics: readonly ts.Diagnostic[];
  parsed: ts.ParsedCommandLine;
  projectRootDir: string;
}): void {
  const errors = [...options.diagnostics, ...options.parsed.errors];
  if (errors.length === 0) return;
  throw new Error(
    ts.formatDiagnosticsWithColorAndContext(
      errors,
      createFormatHost(options.projectRootDir),
    ),
  );
}

export function createParsedCheckerProjectConfig(options: {
  extensions: string[];
  fileNames: string[];
  parsed: ts.ParsedCommandLine;
}): ParsedCheckerProjectConfig {
  return {
    extensions: normalizeExtensions(options.extensions),
    fileNames: options.fileNames.map(normalizeAbsolutePath).sort(),
    options: options.parsed.options,
  };
}

export function cloneParsedCheckerProjectConfig(
  parsedConfig: ParsedCheckerProjectConfig,
): ParsedCheckerProjectConfig {
  return {
    extensions: [...parsedConfig.extensions],
    fileNames: [...parsedConfig.fileNames],
    options: { ...parsedConfig.options },
  };
}

function parseTypeScriptCommandLine(options: {
  extraFileExtensions?: readonly ts.FileExtensionInfo[];
  parseOptions: CheckerProjectConfigParseOptions;
}): ts.ParsedCommandLine {
  const diagnostics: ts.Diagnostic[] = [];
  const host = createProjectParseHost(options.parseOptions.virtualFiles);
  const parsed = requireParsedCommandLine({
    diagnostics,
    parsed: ts.getParsedCommandLineOfConfigFile(
      options.parseOptions.configPath,
      {},
      {
        ...host,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          diagnostics.push(diagnostic);
        },
      },
      undefined,
      undefined,
      options.extraFileExtensions,
    ),
    projectRootDir: options.parseOptions.projectRootDir,
  });
  assertNoParseErrors({
    diagnostics,
    parsed,
    projectRootDir: options.parseOptions.projectRootDir,
  });
  return parsed;
}

export function parseProjectConfigWithExtensions(
  options: CheckerProjectConfigParseOptions,
  extensions: string[],
): ParsedCheckerProjectConfig {
  const resolvedExtensions = resolveExtensionsForChecker(options, extensions);
  const extraFileExtensions = createExtraFileExtensions(resolvedExtensions);
  const parsed = parseTypeScriptCommandLine({
    extraFileExtensions:
      extraFileExtensions.length === 0 ? undefined : extraFileExtensions,
    parseOptions: options,
  });
  return createParsedCheckerProjectConfig({
    extensions: resolvedExtensions,
    fileNames: parsed.fileNames,
    parsed,
  });
}
