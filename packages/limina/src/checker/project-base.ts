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
            if (virtualFiles.has(normalizeAbsolutePath(fileName))) return true;
            return ts.sys.fileExists(fileName);
          },
          readFile(fileName: string, encoding?: string): string | undefined {
            const content = virtualFiles.get(normalizeAbsolutePath(fileName));
            if (content !== undefined) return content;
            return ts.sys.readFile(fileName, encoding);
          },
        };
  if (recorder === undefined) return base;
  return {
    ...base,
    readFile(fileName, encoding): string | undefined {
      const content = base.readFile(fileName, encoding);
      if (content !== undefined) {
        recorder.contentByPath.set(normalizeAbsolutePath(fileName), content);
      }
      return content;
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
  throw new Error(
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
    fileNames: options.fileNames.map(normalizeAbsolutePath).sort(),
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
    ...[...options.extendedConfigCache.values()].map((entry) =>
      normalizeAbsolutePath(entry.extendedResult.fileName),
    ),
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

function parseTypeScriptCommandLine(options: {
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
