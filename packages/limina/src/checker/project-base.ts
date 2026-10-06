import { observeAnalysisRead } from '#utils/analysis-input';
import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import {
  createExtraFileExtensions,
  normalizeExtensions,
  resolveExtensionsForChecker,
} from './extensions';
import type {
  CheckerConfigClosureEntry,
  CheckerProjectConfigParseOptions,
  ParsedCheckerProjectConfig,
} from './types';

export class TypeScriptConfigInputError extends Error {}

interface ConfigReadRecorder {
  contentByPath: Map<string, string>;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function createProjectParseHost(
  virtualFiles: ReadonlyMap<string, string> | undefined,
  recorder?: ConfigReadRecorder,
): typeof ts.sys {
  const base =
    virtualFiles === undefined
      ? ts.sys
      : {
          ...ts.sys,
          fileExists(fileName: string): boolean {
            return (
              virtualFiles.has(normalizeAbsolutePath(fileName)) ||
              ts.sys.fileExists(fileName)
            );
          },
          readFile(fileName: string, encoding?: string): string | undefined {
            const content = virtualFiles.get(normalizeAbsolutePath(fileName));
            return content === undefined
              ? ts.sys.readFile(fileName, encoding)
              : content;
          },
        };
  if (recorder === undefined) return base;
  return {
    ...base,
    readDirectory: (...arguments_) => {
      const read = () => base.readDirectory(...arguments_);
      const value = read();
      observeAnalysisRead({
        path: arguments_[0],
        key: JSON.stringify(['config-files', arguments_]),
        value,
        read,
      });
      return value;
    },
    readFile(fileName, encoding): string | undefined {
      const content = base.readFile(fileName, encoding);
      if (content !== undefined) {
        recorder.contentByPath.set(normalizeAbsolutePath(fileName), content);
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
  parsed: ts.ParsedCommandLine;
}): ParsedCheckerProjectConfig {
  return {
    configClosure: options.configClosure.map((entry) => ({ ...entry })),
    extensions: normalizeExtensions(options.extensions),
    fileNames: options.fileNames
      .map(normalizeAbsolutePath)
      .sort((left, right) => Number(left > right) - Number(left < right)),
    options: options.parsed.options,
  };
}

export function cloneParsedCheckerProjectConfig(
  parsedConfig: ParsedCheckerProjectConfig,
): ParsedCheckerProjectConfig {
  return {
    configClosure: parsedConfig.configClosure.map((entry) => ({ ...entry })),
    extensions: [...parsedConfig.extensions],
    fileNames: [...parsedConfig.fileNames],
    options: { ...parsedConfig.options },
    vueSemanticIdentity: parsedConfig.vueSemanticIdentity,
  };
}

function createConfigClosure(options: {
  configFileName: string;
  contentByPath: ReadonlyMap<string, string>;
  extendedConfigCache: ReadonlyMap<string, ts.ExtendedConfigCacheEntry>;
  host: typeof ts.sys;
}): CheckerConfigClosureEntry[] {
  const filePaths = new Set([
    normalizeAbsolutePath(options.configFileName),
    ...options.extendedConfigCache
      .values()
      .map((entry) => normalizeAbsolutePath(entry.extendedResult.fileName)),
  ]);
  return [...filePaths]
    .map((filePath) => {
      const content =
        options.contentByPath.get(filePath) ?? options.host.readFile(filePath);
      if (content === undefined) {
        throw new Error(
          `Parsed TypeScript config closure entry is unreadable: ${filePath}`,
        );
      }
      return { contentHash: hashText(content), filePath };
    })
    .sort((left, right) => compareCodeUnits(left.filePath, right.filePath));
}

export function parseTypeScriptCommandLine(options: {
  extraFileExtensions?: readonly ts.FileExtensionInfo[];
  parseOptions: CheckerProjectConfigParseOptions;
}): {
  configClosure: CheckerConfigClosureEntry[];
  parsed: ts.ParsedCommandLine;
} {
  const diagnostics: ts.Diagnostic[] = [];
  const recorder: ConfigReadRecorder = { contentByPath: new Map() };
  const host = createProjectParseHost(
    options.parseOptions.virtualFiles,
    recorder,
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
  return {
    configClosure: createConfigClosure({
      configFileName: options.parseOptions.configPath,
      contentByPath: recorder.contentByPath,
      extendedConfigCache,
      host,
    }),
    parsed,
  };
}

export function parseProjectConfigWithExtensions(
  options: CheckerProjectConfigParseOptions,
  extensions: string[],
): ParsedCheckerProjectConfig {
  const resolvedExtensions = resolveExtensionsForChecker(options, extensions);
  const extraFileExtensions = createExtraFileExtensions(resolvedExtensions);
  const { configClosure, parsed } = parseTypeScriptCommandLine({
    extraFileExtensions:
      extraFileExtensions.length === 0 ? undefined : extraFileExtensions,
    parseOptions: options,
  });
  return createParsedCheckerProjectConfig({
    configClosure,
    extensions: resolvedExtensions,
    fileNames: parsed.fileNames,
    parsed,
  });
}
