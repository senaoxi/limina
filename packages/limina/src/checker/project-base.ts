import {
  observeAnalysisRead,
  readAnalysisInput,
  typeScriptDirectoryDescriptor,
} from '#utils/analysis-input';
import { AnalysisInputDriftError } from '#utils/analysis-input-drift';
import { cloneCompilerOptions } from '#utils/compiler-options';
import { normalizeAbsolutePath } from '#utils/path';
import { parseLiveConfig } from '#utils/resolved-config-cache';
import { readSourceConfigText } from '#utils/source-config-text';
import ts from 'typescript';
import {
  currentProfile,
  observeWork,
} from '../application/analysis/observability';
import {
  createExtraFileExtensions,
  normalizeExtensions,
  resolveExtensionsForChecker,
} from './extensions';
import {
  projectResolvedConfig,
  type ResolvedConfigProjection,
} from './resolved-config';
import { retainSvelteSourceMembership } from './svelte-source-membership';
import type {
  CheckerConfigClosureEntry,
  CheckerProjectConfigParseOptions,
  ParsedCheckerProjectConfig,
} from './types';

export class TypeScriptConfigInputError extends Error {
  readonly diagnosticCodes: readonly number[];
  constructor(message: string, diagnostics: readonly ts.Diagnostic[] = []) {
    super(message);
    this.diagnosticCodes = diagnostics.map(({ code }) => code);
  }
}

export function observeConfigParse<T>(
  configPath: string,
  operation:
    | 'source-config.live-parse'
    | 'source-config.role-probe'
    | 'source-config.vue-metadata'
    | 'source-config.vue-metadata-no-root-scan',
  parse: () => T,
): T {
  const observer = currentProfile();
  if (observer === undefined) return parse();
  if (operation === 'source-config.role-probe')
    return observeWork(observer, operation, parse, [
      'project',
      observer.project(configPath),
    ]);
  return observer.currentOperation === 'source-config.authorized-read'
    ? observeWork(observer, operation, parse)
    : parse();
}

export function parseWithObservedConfigInputs<T>(
  host: typeof ts.sys,
  parse: (host: typeof ts.sys) => T,
): T {
  let drift: AnalysisInputDriftError | undefined;
  let result: T;
  try {
    result = parse({
      ...host,
      readFile(fileName, encoding) {
        try {
          return host.readFile(fileName, encoding);
        } catch (error) {
          if (error instanceof AnalysisInputDriftError) drift ??= error;
          throw error;
        }
      },
    });
  } catch (error) {
    throw drift ?? error;
  }
  // Compilers can translate Host read failures into diagnostics or defaults.
  if (drift !== undefined) throw drift;
  return result;
}

export function createProjectParseHost(
  virtualFiles: ReadonlyMap<string, string> | undefined,
  contentByPath?: Map<string, string>,
  compiler: typeof ts = ts,
  config?: {
    rootSelectors?: Parameters<typeof ts.sys.readDirectory>[];
  },
): typeof ts.sys {
  const base = compiler.sys;
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
      config?.rootSelectors?.push(arguments_);
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
      const file = normalizeAbsolutePath(fileName);
      const content = readSourceConfigText(file, virtualFiles, (name) =>
        base.readFile(name, encoding),
      );
      if (content !== undefined) {
        contentByPath?.set(file, content);
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
    options.diagnostics,
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
    errors,
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
    configClosure: [...options.configClosure],
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
    configClosure: [...parsedConfig.configClosure],
    extensions: [...parsedConfig.extensions],
    fileNames: [...parsedConfig.fileNames],
    rootSelectors: parsedConfig.rootSelectors?.map(
      ([path, extensions, excludes, includes, depth]) => [
        path,
        extensions?.slice(),
        excludes?.slice(),
        includes?.slice(),
        depth,
      ],
    ),
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
  roleOnly?: boolean;
}

const projectParseSystem = { ...ts.sys };

export function canReuseConfigProjection(compiler: typeof ts): boolean {
  return (
    compiler === ts &&
    ts.version === '6.0.3' &&
    !process.versions.pnp &&
    ts.sys.getCurrentDirectory === projectParseSystem.getCurrentDirectory &&
    ts.sys.useCaseSensitiveFileNames ===
      projectParseSystem.useCaseSensitiveFileNames &&
    ts.sys.readFile === projectParseSystem.readFile &&
    ts.sys.fileExists === projectParseSystem.fileExists &&
    ts.sys.directoryExists === projectParseSystem.directoryExists &&
    ts.sys.getDirectories === projectParseSystem.getDirectories &&
    ts.sys.realpath === projectParseSystem.realpath &&
    ts.sys.readDirectory === projectParseSystem.readDirectory
  );
}

export function parseTypeScriptCommandLine(
  options: ConfigParseRequest,
): ResolvedConfigProjection {
  const { parseOptions, extraFileExtensions } = options;
  const configPath = normalizeAbsolutePath(parseOptions.configPath);
  const key = parseOptions.virtualFiles?.size
    ? undefined
    : JSON.stringify([
        options.roleOnly ? 'source-config-role' : 'command-line',
        ts.version,
        ts.sys.getCurrentDirectory(),
        ts.sys.useCaseSensitiveFileNames,
        parseOptions.configPath,
        parseOptions.allowNoInputDiagnostics === true,
        extraFileExtensions ?? [],
      ]);
  return parseLiveConfig(
    () =>
      observeConfigParse(
        configPath,
        options.roleOnly
          ? 'source-config.role-probe'
          : 'source-config.live-parse',
        () => parseConfig(options),
      ),
    key,
    key !== undefined &&
      !options.roleOnly &&
      configPath === parseOptions.configPath &&
      canReuseConfigProjection(ts)
      ? { configPath, key }
      : undefined,
  );
}

function parseConfig(options: ConfigParseRequest): ResolvedConfigProjection {
  const diagnostics: ts.Diagnostic[] = [];
  const contentByPath = new Map<string, string>();
  const rootSelectors: Parameters<typeof ts.sys.readDirectory>[] = [];
  const host = createProjectParseHost(
    options.parseOptions.virtualFiles,
    contentByPath,
    ts,
    { rootSelectors },
  );
  const extendedConfigCache = new Map<string, ts.ExtendedConfigCacheEntry>();
  const result = parseWithObservedConfigInputs(host, (observedHost) =>
    ts.getParsedCommandLineOfConfigFile(
      options.parseOptions.configPath,
      {},
      {
        ...observedHost,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          diagnostics.push(diagnostic);
        },
      },
      extendedConfigCache,
      undefined,
      options.extraFileExtensions,
    ),
  );
  const parsed = requireParsedCommandLine({
    diagnostics,
    parsed: result,
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
    rootSelectors,
  );
}

export function parseProjectConfigWithExtensions(
  options: CheckerProjectConfigParseOptions,
  extensions: string[],
): ParsedCheckerProjectConfig {
  const resolvedExtensions = resolveExtensionsForChecker(options, extensions);
  const extraFileExtensions = createExtraFileExtensions(resolvedExtensions);
  const request = {
    extraFileExtensions:
      extraFileExtensions.length === 0 ? undefined : extraFileExtensions,
    parseOptions: options,
  };
  const projection = parseTypeScriptCommandLine(request);
  if (resolvedExtensions.includes('.svelte'))
    retainSvelteSourceMembership(
      options.configPath,
      projection,
      () => parseConfig(request).parsed.fileNames,
    );
  const { configClosure, configuredVueExtensions, parsed, rootSelectors } =
    projection;
  return {
    ...createParsedCheckerProjectConfig({
      configClosure,
      configuredVueExtensions,
      extensions: resolvedExtensions,
      fileNames: parsed.fileNames,
      parsed,
    }),
    rootSelectors,
  };
}
