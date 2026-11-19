import {
  observeAnalysisRead,
  readAnalysisInput,
  readTypeScriptConfigInput,
  typeScriptDirectoryDescriptor,
} from '#utils/analysis-input';
import { cloneCompilerOptions } from '#utils/compiler-options';
import { normalizeAbsolutePath } from '#utils/path';
import { parseLiveConfig } from '#utils/resolved-config-cache';
import ts from 'typescript';
import {
  createExtraFileExtensions,
  normalizeExtensions,
  resolveExtensionsForChecker,
} from './extensions';
import {
  projectResolvedConfig,
  type ResolvedConfigProjection,
} from './resolved-config';
import type {
  CheckerConfigClosureEntry,
  CheckerProjectConfigParseOptions,
  ParsedCheckerProjectConfig,
} from './types';

export class TypeScriptConfigInputError extends Error {}

export function createProjectParseHost(
  virtualFiles: ReadonlyMap<string, string> | undefined,
  contentByPath?: Map<string, string>,
): typeof ts.sys {
  const base = ts.sys;
  return {
    ...base,
    fileExists: (fileName) =>
      virtualFiles?.has(normalizeAbsolutePath(fileName)) ||
      readAnalysisInput(fileName, () => base.fileExists(fileName), 'file'),
    directoryExists: (fileName) =>
      readAnalysisInput(
        fileName,
        () => base.directoryExists(fileName),
        'directory',
      ),
    getDirectories: (fileName) =>
      readAnalysisInput(
        fileName,
        () => base.getDirectories(fileName),
        'directories',
      ),
    realpath:
      base.realpath &&
      ((fileName) =>
        readAnalysisInput(
          fileName,
          () => base.realpath!(fileName),
          'realpath',
        )),
    readDirectory: (...arguments_) => {
      const read = () => base.readDirectory(...arguments_);
      const value = read();
      observeAnalysisRead({
        path: arguments_[0],
        descriptor: typeScriptDirectoryDescriptor(arguments_),
        key: JSON.stringify(['config-files', arguments_]),
        value,
        read,
      });
      return value;
    },
    readFile(fileName, encoding): string | undefined {
      const content =
        virtualFiles?.get(normalizeAbsolutePath(fileName)) ??
        readTypeScriptConfigInput(fileName, () =>
          base.readFile(fileName, encoding),
        );
      if (content !== undefined) {
        contentByPath?.set(normalizeAbsolutePath(fileName), content);
      }
      return content;
    },
  };
}

export function createFormatHost(
  rootDirectory: string,
): ts.FormatDiagnosticsHost {
  return {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => rootDirectory,
    getNewLine: () => '\n',
  };
}

function requireParsedCommandLine(options: {
  diagnostics: readonly ts.Diagnostic[];
  parsed: ts.ParsedCommandLine | undefined;
  projectRootDir: string;
}): ts.ParsedCommandLine {
  if (options.parsed !== undefined) return options.parsed;
  throw new TypeScriptConfigInputError(
    ts.formatDiagnosticsWithColorAndContext(
      options.diagnostics,
      createFormatHost(options.projectRootDir),
    ),
  );
}

function assertNoParseErrors(options: {
  allowNoInputDiagnostics?: boolean;
  diagnostics: readonly ts.Diagnostic[];
  parsed: ts.ParsedCommandLine;
  projectRootDir: string;
}): void {
  const errors = [...options.diagnostics, ...options.parsed.errors].filter(
    (diagnostic) =>
      options.allowNoInputDiagnostics !== true ||
      (diagnostic.code !== 18_002 && diagnostic.code !== 18_003),
  );
  if (errors.length === 0) return;
  throw new TypeScriptConfigInputError(
    ts.formatDiagnosticsWithColorAndContext(
      errors,
      createFormatHost(options.projectRootDir),
    ),
  );
}

export function createParsedCheckerProjectConfig(options: {
  configClosure: CheckerConfigClosureEntry[];
  extensions: string[];
  fileNames: string[];
  parsed: Pick<ts.ParsedCommandLine, 'options' | 'projectReferences'>;
  configuredVueExtensions: string[];
}): ParsedCheckerProjectConfig {
  return {
    configuredVueExtensions: options.configuredVueExtensions,
    configClosure: options.configClosure.map((entry) => ({ ...entry })),
    extensions: normalizeExtensions(options.extensions),
    fileNames: options.fileNames
      .map(normalizeAbsolutePath)
      .sort((left, right) => Number(left > right) - Number(left < right)),
    options: options.parsed.options,
    projectReferences: options.parsed.projectReferences,
  };
}

export function cloneParsedCheckerProjectConfig(
  parsedConfig: ParsedCheckerProjectConfig,
): ParsedCheckerProjectConfig {
  return {
    configuredVueExtensions: parsedConfig.configuredVueExtensions?.slice(),
    configClosure: parsedConfig.configClosure.map((entry) => ({ ...entry })),
    extensions: [...parsedConfig.extensions],
    fileNames: [...parsedConfig.fileNames],
    options: cloneCompilerOptions(parsedConfig.options),
    projectReferences: parsedConfig.projectReferences?.map((reference) => ({
      ...reference,
    })),
    vueSemanticIdentity: parsedConfig.vueSemanticIdentity,
  };
}

interface ConfigParseRequest {
  extraFileExtensions?: readonly ts.FileExtensionInfo[];
  parseOptions: CheckerProjectConfigParseOptions;
}

export function parseTypeScriptCommandLine(
  options: ConfigParseRequest,
): ResolvedConfigProjection {
  const { parseOptions, extraFileExtensions } = options;
  return parseLiveConfig(
    () => parseConfig(options),
    parseOptions.virtualFiles?.size
      ? undefined
      : JSON.stringify([
          'command-line',
          ts.version,
          ts.sys.getCurrentDirectory(),
          ts.sys.useCaseSensitiveFileNames,
          normalizeAbsolutePath(parseOptions.configPath),
          parseOptions.allowNoInputDiagnostics === true,
          extraFileExtensions ?? [],
        ]),
  );
}

function parseConfig(options: ConfigParseRequest): ResolvedConfigProjection {
  const diagnostics: ts.Diagnostic[] = [];
  const contentByPath = new Map<string, string>();
  const host = createProjectParseHost(
    options.parseOptions.virtualFiles,
    contentByPath,
  );
  const extendedConfigCache = new Map<string, ts.ExtendedConfigCacheEntry>();
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
      extendedConfigCache,
      undefined,
      options.extraFileExtensions,
    ),
    projectRootDir: options.parseOptions.projectRootDir,
  });
  assertNoParseErrors({
    allowNoInputDiagnostics: options.parseOptions.allowNoInputDiagnostics,
    diagnostics,
    parsed,
    projectRootDir: options.parseOptions.projectRootDir,
  });
  return projectResolvedConfig(
    options.parseOptions.configPath,
    parsed,
    extendedConfigCache,
    contentByPath,
  );
}

export function parseProjectConfigWithExtensions(
  options: CheckerProjectConfigParseOptions,
  extensions: string[],
): ParsedCheckerProjectConfig {
  const resolvedExtensions = resolveExtensionsForChecker(options, extensions);
  const extraFileExtensions = createExtraFileExtensions(resolvedExtensions);
  const { configClosure, configuredVueExtensions, parsed } =
    parseTypeScriptCommandLine({
      extraFileExtensions:
        extraFileExtensions.length === 0 ? undefined : extraFileExtensions,
      parseOptions: options,
    });
  return createParsedCheckerProjectConfig({
    configClosure,
    configuredVueExtensions,
    extensions: resolvedExtensions,
    fileNames: parsed.fileNames,
    parsed,
  });
}
