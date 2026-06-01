import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import type {
  BuiltinCheckerPreset,
  CheckerConfig,
  CheckerExecutionKind,
  CheckerPreset,
  ResolvedCheckerConfig,
} from './config';
import { normalizeAbsolutePath, toRelativePath } from './utils/path';

type TypeScriptExtensionGroups = readonly (readonly string[])[];

interface TypeScriptExtensionApi {
  getSupportedExtensions: (
    options?: ts.CompilerOptions,
    extraFileExtensions?: readonly ts.FileExtensionInfo[],
  ) => TypeScriptExtensionGroups;
  getSupportedExtensionsWithJsonIfResolveJsonModule: (
    options: ts.CompilerOptions | undefined,
    supportedExtensions: TypeScriptExtensionGroups,
  ) => TypeScriptExtensionGroups;
}

function getTypeScriptExtensionApi(): TypeScriptExtensionApi {
  const api = ts as typeof ts & Partial<TypeScriptExtensionApi>;

  if (
    typeof api.getSupportedExtensions !== 'function' ||
    typeof api.getSupportedExtensionsWithJsonIfResolveJsonModule !== 'function'
  ) {
    throw new TypeError(
      'Unable to resolve TypeScript checker extensions: the TypeScript compiler API does not expose supported extension metadata.',
    );
  }

  return api as TypeScriptExtensionApi;
}

function flattenTypeScriptExtensionGroups(
  groups: TypeScriptExtensionGroups,
): string[] {
  return groups.flatMap((group) => [...group]);
}

function getTypeScriptCheckerExtensions(): string[] {
  const api = getTypeScriptExtensionApi();
  const options: ts.CompilerOptions = {
    resolveJsonModule: true,
  };

  return normalizeExtensions(
    flattenTypeScriptExtensionGroups(
      api.getSupportedExtensionsWithJsonIfResolveJsonModule(
        options,
        api.getSupportedExtensions(options),
      ),
    ),
  );
}

function getNativeTypeScriptProjectExtensions(): string[] {
  const api = getTypeScriptExtensionApi();
  const options: ts.CompilerOptions = {
    allowJs: true,
    resolveJsonModule: true,
  };

  return normalizeExtensions(
    flattenTypeScriptExtensionGroups(
      api.getSupportedExtensionsWithJsonIfResolveJsonModule(
        options,
        api.getSupportedExtensions(options),
      ),
    ),
  );
}

function getSvelteCheckerExtensions(): string[] {
  return normalizeExtensions([...getTypeScriptCheckerExtensions(), '.svelte']);
}

export interface CheckerCommandTarget {
  args: string[];
  command: string;
  label: string;
}

export interface CheckerCommandTargetOptions {
  checker: ResolvedCheckerConfig;
  commandOverride?: string;
  configPath: string;
  executionKind: CheckerExecutionKind;
  projectRootDir: string;
}

export interface CheckerProjectConfigParseOptions {
  configPath: string;
  extensions?: string[];
  projectRootDir: string;
}

export interface ParsedCheckerProjectConfig {
  extensions: string[];
  fileNames: string[];
  options: ts.CompilerOptions;
}

export interface CheckerProjectParseContext {
  checkerPresets: CheckerPreset[];
  extensions: string[];
}

export interface CheckerModuleResolveOptions {
  compilerOptions: ts.CompilerOptions;
  containingFile: string;
  extensions: string[];
  specifier: string;
}

export interface CheckerAdapter {
  createCommandTarget: (
    options: CheckerCommandTargetOptions,
  ) => CheckerCommandTarget;
  extensions: (options: CheckerProjectConfigParseOptions) => string[];
  execution: CheckerExecutionKind;
  packageNames: string[];
  parseProjectConfig: (
    options: CheckerProjectConfigParseOptions,
  ) => ParsedCheckerProjectConfig;
  preset: BuiltinCheckerPreset;
  resolveModuleName: (options: CheckerModuleResolveOptions) => string | null;
  sourceGraph: boolean;
}

export interface MissingCheckerPeerDependency {
  checkerNames: string[];
  packageName: string;
}

export type CheckerPackageResolver = (options: {
  packageName: string;
  projectRootDir: string;
}) => string | undefined;

interface VueLanguageCore {
  createParsedCommandLine: (
    tsModule: typeof ts,
    host: typeof ts.sys,
    configFileName: string,
  ) => {
    errors?: readonly ts.Diagnostic[];
    vueOptions?: unknown;
  };
  getAllExtensions: (vueOptions: unknown) => string[];
}

interface VueTscShowConfig {
  files?: unknown;
}

function createFormatHost(rootDir: string): ts.FormatDiagnosticsHost {
  return {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => rootDir,
    getNewLine: () => '\n',
  };
}

function readTypeScriptProjectConfig(
  options: CheckerProjectConfigParseOptions,
): {
  diagnostics: ts.Diagnostic[];
  parsed: ts.ParsedCommandLine;
} {
  const diagnostics: ts.Diagnostic[] = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(
    options.configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
    },
  );

  if (!parsed) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(
        diagnostics,
        createFormatHost(options.projectRootDir),
      ),
    );
  }

  return {
    diagnostics,
    parsed,
  };
}

function createParsedCheckerProjectConfig(options: {
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

function createExtraFileExtensions(
  extensions: string[],
): ts.FileExtensionInfo[] {
  const nativeExtensions = new Set<string>(
    getNativeTypeScriptProjectExtensions(),
  );

  return extensions
    .filter((extension) => !nativeExtensions.has(extension))
    .map((extension) => ({
      extension,
      isMixedContent: true,
      scriptKind: ts.ScriptKind.Deferred,
    }));
}

function parseProjectConfigWithExtraFileExtensions(
  options: CheckerProjectConfigParseOptions,
  extensions: string[],
): ParsedCheckerProjectConfig {
  const diagnostics: ts.Diagnostic[] = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(
    options.configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
    },
    undefined,
    undefined,
    createExtraFileExtensions(extensions),
  );

  if (!parsed) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(
        diagnostics,
        createFormatHost(options.projectRootDir),
      ),
    );
  }

  const errors = [...diagnostics, ...parsed.errors];

  if (errors.length > 0) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(
        errors,
        createFormatHost(options.projectRootDir),
      ),
    );
  }

  return createParsedCheckerProjectConfig({
    extensions,
    fileNames: parsed.fileNames,
    parsed,
  });
}

function parseTypeScriptProjectConfig(
  options: CheckerProjectConfigParseOptions,
  extensions: string[],
): ParsedCheckerProjectConfig {
  const { diagnostics, parsed } = readTypeScriptProjectConfig(options);
  const errors = [...diagnostics, ...parsed.errors];

  if (errors.length > 0) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(
        errors,
        createFormatHost(options.projectRootDir),
      ),
    );
  }

  return createParsedCheckerProjectConfig({
    extensions,
    fileNames: parsed.fileNames,
    parsed,
  });
}

function isNoInputsFoundDiagnostic(diagnostic: ts.Diagnostic): boolean {
  return diagnostic.code === 18_003;
}

function formatProjectConfigParseError(options: { error: unknown }): string {
  if (
    options.error &&
    typeof options.error === 'object' &&
    'stderr' in options.error &&
    typeof options.error.stderr === 'string' &&
    options.error.stderr.trim().length > 0
  ) {
    return options.error.stderr.trim();
  }

  if (
    options.error &&
    typeof options.error === 'object' &&
    'stdout' in options.error &&
    typeof options.error.stdout === 'string' &&
    options.error.stdout.trim().length > 0
  ) {
    return options.error.stdout.trim();
  }

  return String(options.error);
}

function parseVueTscShowConfigFileNames(
  options: CheckerProjectConfigParseOptions,
): string[] | null {
  const requireFromChecker = createCheckerPackageRequire({
    packageName: 'vue-tsc',
    projectRootDir: options.projectRootDir,
  });

  if (!requireFromChecker) {
    return null;
  }

  let showConfigText: string;

  try {
    showConfigText = execFileSync(
      process.execPath,
      [
        requireFromChecker.resolve('vue-tsc/bin/vue-tsc.js'),
        '--showConfig',
        '-p',
        options.configPath,
      ],
      {
        cwd: options.projectRootDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    throw new Error(
      [
        'Unable to parse Vue checker project config with vue-tsc:',
        `  config: ${toRelativePath(options.projectRootDir, options.configPath)}`,
        `  reason: ${formatProjectConfigParseError({
          error,
        })}`,
      ].join('\n'),
    );
  }

  const showConfig = JSON.parse(showConfigText) as VueTscShowConfig;

  if (!Array.isArray(showConfig.files)) {
    return [];
  }

  return showConfig.files
    .filter((fileName): fileName is string => typeof fileName === 'string')
    .map((fileName) =>
      normalizeAbsolutePath(
        path.resolve(path.dirname(options.configPath), fileName),
      ),
    )
    .sort();
}

function isModuleNotFoundError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'MODULE_NOT_FOUND'
  );
}

function createCheckerPackageRequire(options: {
  packageName: string;
  projectRootDir: string;
}): ReturnType<typeof createRequire> | null {
  for (const basePath of [
    path.join(options.projectRootDir, 'package.json'),
    import.meta.url,
  ]) {
    const requireFromBase = createRequire(basePath);

    try {
      return createRequire(
        requireFromBase.resolve(`${options.packageName}/package.json`),
      );
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
      ) {
        return createRequire(requireFromBase.resolve(options.packageName));
      }

      if (isModuleNotFoundError(error)) {
        continue;
      }

      throw error;
    }
  }

  return null;
}

function getVueLanguageCore(options: {
  packageName: string;
  projectRootDir: string;
}): VueLanguageCore {
  const requireFromChecker = createCheckerPackageRequire(options);

  if (!requireFromChecker) {
    throw new Error(
      [
        'Unable to resolve Vue checker package:',
        `  package: ${options.packageName}`,
        `  root: ${options.projectRootDir}`,
      ].join('\n'),
    );
  }

  try {
    return requireFromChecker('@vue/language-core') as VueLanguageCore;
  } catch (error) {
    if (isModuleNotFoundError(error)) {
      throw new Error(
        [
          'Unable to resolve Vue checker language core:',
          `  checker package: ${options.packageName}`,
          '  required package: @vue/language-core',
        ].join('\n'),
      );
    }

    throw error;
  }
}

function resolveVueProjectExtensions(
  options: CheckerProjectConfigParseOptions,
  packageName: string,
): string[] {
  const vueLanguageCore = getVueLanguageCore({
    packageName,
    projectRootDir: options.projectRootDir,
  });

  const parsed = vueLanguageCore.createParsedCommandLine(
    ts,
    ts.sys,
    normalizeAbsolutePath(options.configPath),
  );

  try {
    return normalizeExtensions([
      ...getTypeScriptCheckerExtensions(),
      ...vueLanguageCore.getAllExtensions(parsed.vueOptions),
    ]);
  } catch (error) {
    throw new Error(
      [
        'Unable to resolve Vue checker extensions:',
        `  checker package: ${packageName}`,
        `  config: ${toRelativePath(options.projectRootDir, options.configPath)}`,
        `  reason: ${String(error)}`,
      ].join('\n'),
    );
  }
}

function parseProjectConfigWithExtensions(
  options: CheckerProjectConfigParseOptions,
  extensions: string[],
): ParsedCheckerProjectConfig {
  const resolvedExtensions =
    options.extensions && options.extensions.length > 0
      ? options.extensions
      : extensions;

  return createExtraFileExtensions(resolvedExtensions).length > 0
    ? parseProjectConfigWithExtraFileExtensions(options, resolvedExtensions)
    : parseTypeScriptProjectConfig(options, resolvedExtensions);
}

function parseVueProjectConfig(
  options: CheckerProjectConfigParseOptions,
  packageName: string,
): ParsedCheckerProjectConfig {
  const extensions = resolveVueProjectExtensionsForChecker(
    options,
    packageName,
  );
  const vueTscFileNames =
    packageName === 'vue-tsc' ? parseVueTscShowConfigFileNames(options) : null;

  if (!vueTscFileNames) {
    // vue-tsgo does not expose a synchronous showConfig-style file list, so
    // keep non-native extension support scoped to Vue checker adapters.
    return parseProjectConfigWithExtraFileExtensions(options, extensions);
  }

  const { diagnostics, parsed } = readTypeScriptProjectConfig(options);
  const errors = [...diagnostics, ...parsed.errors].filter(
    (diagnostic) =>
      !(vueTscFileNames.length > 0 && isNoInputsFoundDiagnostic(diagnostic)),
  );

  if (errors.length > 0) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(
        errors,
        createFormatHost(options.projectRootDir),
      ),
    );
  }

  return createParsedCheckerProjectConfig({
    extensions,
    fileNames: vueTscFileNames,
    parsed,
  });
}

function resolveExtensionsForChecker(
  options: CheckerProjectConfigParseOptions,
  extensions: string[],
): string[] {
  return normalizeExtensions(
    options.extensions && options.extensions.length > 0
      ? options.extensions
      : extensions,
  );
}

function resolveVueProjectExtensionsForChecker(
  options: CheckerProjectConfigParseOptions,
  packageName: string,
): string[] {
  return normalizeExtensions([
    ...(options.extensions ?? []),
    ...resolveVueProjectExtensions(options, packageName),
  ]);
}

function isRelativeSpecifier(specifier: string): boolean {
  return (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  );
}

function pathHasExtension(value: string): boolean {
  return path.extname(value).length > 0;
}

function candidatePathsForBasePath(
  basePath: string,
  extensions: string[],
): string[] {
  if (pathHasExtension(basePath)) {
    return [basePath];
  }

  return extensions.flatMap((extension) => [
    `${basePath}${extension}`,
    path.join(basePath, `index${extension}`),
  ]);
}

function resolveCandidatePath(candidatePath: string): string | null {
  if (!existsSync(candidatePath)) {
    return null;
  }

  if (!statSync(candidatePath).isFile()) {
    return null;
  }

  return normalizeAbsolutePath(candidatePath);
}

function resolveRelativeModuleCandidate(options: {
  containingFile: string;
  extensions: string[];
  specifier: string;
}): string | null {
  if (!isRelativeSpecifier(options.specifier)) {
    return null;
  }

  const resolvedSpecifierPath = path.resolve(
    path.dirname(options.containingFile),
    options.specifier,
  );

  for (const candidatePath of candidatePathsForBasePath(
    resolvedSpecifierPath,
    options.extensions,
  )) {
    const resolvedPath = resolveCandidatePath(candidatePath);

    if (resolvedPath) {
      return resolvedPath;
    }
  }

  return null;
}

function matchPathPattern(pattern: string, specifier: string): string | null {
  const wildcardIndex = pattern.indexOf('*');

  if (wildcardIndex === -1) {
    return pattern === specifier ? '' : null;
  }

  const prefix = pattern.slice(0, wildcardIndex);
  const suffix = pattern.slice(wildcardIndex + 1);

  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
    return null;
  }

  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function applyPathPattern(pattern: string, matchedText: string): string {
  return pattern.includes('*') ? pattern.replace('*', matchedText) : pattern;
}

function getPathsBasePath(compilerOptions: ts.CompilerOptions): string | null {
  const pathsBasePath = (compilerOptions as { pathsBasePath?: unknown })
    .pathsBasePath;

  if (typeof pathsBasePath === 'string') {
    return pathsBasePath;
  }

  return compilerOptions.baseUrl ?? null;
}

function resolvePathMappedModuleCandidate(options: {
  compilerOptions: ts.CompilerOptions;
  extensions: string[];
  specifier: string;
}): string | null {
  const paths = options.compilerOptions.paths;
  const pathsBasePath = getPathsBasePath(options.compilerOptions);

  if (!paths || !pathsBasePath) {
    return null;
  }

  const pathEntries = Object.entries(paths).sort(([left], [right]) => {
    const leftPrefixLength = left.split('*')[0]?.length ?? left.length;
    const rightPrefixLength = right.split('*')[0]?.length ?? right.length;

    return rightPrefixLength - leftPrefixLength;
  });

  for (const [alias, targets] of pathEntries) {
    const matchedText = matchPathPattern(alias, options.specifier);

    if (matchedText === null) {
      continue;
    }

    for (const target of targets) {
      const resolvedTargetPath = path.resolve(
        pathsBasePath,
        applyPathPattern(target, matchedText),
      );

      for (const candidatePath of candidatePathsForBasePath(
        resolvedTargetPath,
        options.extensions,
      )) {
        const resolvedPath = resolveCandidatePath(candidatePath);

        if (resolvedPath) {
          return resolvedPath;
        }
      }
    }
  }

  return null;
}

function resolveTypeScriptModuleName(
  options: CheckerModuleResolveOptions,
): string | null {
  const resolved = ts.resolveModuleName(
    options.specifier,
    options.containingFile,
    options.compilerOptions,
    ts.sys,
  ).resolvedModule;

  if (resolved?.resolvedFileName) {
    return normalizeAbsolutePath(resolved.resolvedFileName);
  }

  return (
    resolveRelativeModuleCandidate(options) ??
    resolvePathMappedModuleCandidate(options)
  );
}

function mergeParsedProjectConfigs(
  parsedConfigs: ParsedCheckerProjectConfig[],
  extensions: string[],
): ParsedCheckerProjectConfig {
  const firstConfig = parsedConfigs[0];

  if (!firstConfig) {
    throw new Error('Unable to parse checker project config: no parser ran.');
  }

  return {
    extensions: normalizeExtensions([
      ...extensions,
      ...parsedConfigs.flatMap((parsedConfig) => parsedConfig.extensions),
    ]),
    fileNames: [
      ...new Set(
        parsedConfigs.flatMap((parsedConfig) => parsedConfig.fileNames),
      ),
    ].sort(),
    options: firstConfig.options,
  };
}

export function parseCheckerProjectConfigForContext(options: {
  configPath: string;
  context: CheckerProjectParseContext;
  projectRootDir: string;
}): ParsedCheckerProjectConfig {
  const checkerPresets =
    options.context.checkerPresets.length > 0
      ? options.context.checkerPresets
      : (['tsc'] satisfies CheckerPreset[]);
  const parsedConfigs = checkerPresets.map((preset) => {
    const adapter = getCheckerAdapter(preset);

    if (!adapter) {
      throw new Error(`Checker preset "${preset}" is not supported.`);
    }

    return adapter.parseProjectConfig({
      configPath: options.configPath,
      extensions: options.context.extensions,
      projectRootDir: options.projectRootDir,
    });
  });

  return mergeParsedProjectConfigs(parsedConfigs, options.context.extensions);
}

export function resolveModuleNameWithCheckers(options: {
  compilerOptions: ts.CompilerOptions;
  containingFile: string;
  context: CheckerProjectParseContext;
  specifier: string;
}): string | null {
  const checkerPresets =
    options.context.checkerPresets.length > 0
      ? options.context.checkerPresets
      : (['tsc'] satisfies CheckerPreset[]);

  for (const preset of checkerPresets) {
    const adapter = getCheckerAdapter(preset);

    if (!adapter) {
      continue;
    }

    const resolved = adapter.resolveModuleName({
      compilerOptions: options.compilerOptions,
      containingFile: options.containingFile,
      extensions: options.context.extensions,
      specifier: options.specifier,
    });

    if (resolved) {
      return resolved;
    }
  }

  return null;
}

export function resolveCheckerProjectExtensions(options: {
  configPath: string;
  preset: CheckerPreset;
  projectRootDir: string;
}): string[] {
  const adapter = getCheckerAdapter(options.preset);

  if (!adapter) {
    throw new Error(`Checker preset "${options.preset}" is not supported.`);
  }

  return adapter.extensions({
    configPath: options.configPath,
    projectRootDir: options.projectRootDir,
  });
}

function createTscCommandTarget(
  options: CheckerCommandTargetOptions,
): CheckerCommandTarget {
  const relativeConfigPath = toRelativePath(
    options.projectRootDir,
    options.configPath,
  );

  return {
    args: ['-b', relativeConfigPath, '--pretty', 'false'],
    command: options.commandOverride ?? 'tsc',
    label: `tsc -b ${relativeConfigPath}`,
  };
}

function createTsgoCommandTarget(
  options: CheckerCommandTargetOptions,
): CheckerCommandTarget {
  const relativeConfigPath = toRelativePath(
    options.projectRootDir,
    options.configPath,
  );

  return {
    args: ['-b', relativeConfigPath, '--pretty', 'false'],
    command: 'tsgo',
    label: `tsgo -b ${relativeConfigPath}`,
  };
}

function createVueTscCommandTarget(
  options: CheckerCommandTargetOptions,
): CheckerCommandTarget {
  const relativeConfigPath = toRelativePath(
    options.projectRootDir,
    options.configPath,
  );

  return {
    args: ['-b', relativeConfigPath, '--pretty', 'false'],
    command: 'vue-tsc',
    label: `${options.checker.name}: vue-tsc -b ${relativeConfigPath}`,
  };
}

function createVueTsgoCommandTarget(
  options: CheckerCommandTargetOptions,
): CheckerCommandTarget {
  const relativeConfigPath = toRelativePath(
    options.projectRootDir,
    options.configPath,
  );

  /**
   * vue-tsgo exposes a --build flag, but in current releases that mode
   * generates a transient virtual TS workspace and asks tsgo's LSP for
   * diagnostics. It does not preserve TypeScript project-reference boundaries
   * or provide incremental build semantics, so Limina only uses vue-tsgo as a
   * second-class typecheck execution checker while still using its tsconfig
   * entry for Limina's own graph and proof coverage. Prefer vue-tsc for
   * first-class Vue build checks.
   */
  return {
    args: ['--project', relativeConfigPath],
    command: 'vue-tsgo',
    label: `${options.checker.name}: vue-tsgo --project ${relativeConfigPath}`,
  };
}

function createSvelteCheckCommandTarget(
  options: CheckerCommandTargetOptions,
): CheckerCommandTarget {
  const relativeConfigPath = toRelativePath(
    options.projectRootDir,
    options.configPath,
  );

  return {
    args: ['--tsconfig', relativeConfigPath],
    command: 'svelte-check',
    label: `${options.checker.name}: svelte-check --tsconfig ${relativeConfigPath}`,
  };
}

const builtinCheckerAdapters = {
  'svelte-check': {
    createCommandTarget: createSvelteCheckCommandTarget,
    extensions: (options) =>
      resolveExtensionsForChecker(options, getSvelteCheckerExtensions()),
    execution: 'typecheck',
    packageNames: ['svelte-check'],
    parseProjectConfig: (options) =>
      parseProjectConfigWithExtensions(options, getSvelteCheckerExtensions()),
    preset: 'svelte-check',
    resolveModuleName: resolveTypeScriptModuleName,
    sourceGraph: false,
  },
  tsc: {
    createCommandTarget: createTscCommandTarget,
    extensions: (options) =>
      resolveExtensionsForChecker(options, getTypeScriptCheckerExtensions()),
    execution: 'build',
    packageNames: ['typescript'],
    parseProjectConfig: (options) =>
      parseProjectConfigWithExtensions(
        options,
        getTypeScriptCheckerExtensions(),
      ),
    preset: 'tsc',
    resolveModuleName: resolveTypeScriptModuleName,
    sourceGraph: true,
  },
  tsgo: {
    createCommandTarget: createTsgoCommandTarget,
    extensions: (options) =>
      resolveExtensionsForChecker(options, getTypeScriptCheckerExtensions()),
    execution: 'build',
    packageNames: ['@typescript/native-preview'],
    parseProjectConfig: (options) =>
      parseProjectConfigWithExtensions(
        options,
        getTypeScriptCheckerExtensions(),
      ),
    preset: 'tsgo',
    resolveModuleName: resolveTypeScriptModuleName,
    sourceGraph: true,
  },
  'vue-tsc': {
    createCommandTarget: createVueTscCommandTarget,
    extensions: (options) =>
      resolveVueProjectExtensionsForChecker(options, 'vue-tsc'),
    execution: 'build',
    packageNames: ['vue-tsc', '@vue/compiler-sfc'],
    parseProjectConfig: (options) => parseVueProjectConfig(options, 'vue-tsc'),
    preset: 'vue-tsc',
    resolveModuleName: resolveTypeScriptModuleName,
    sourceGraph: true,
  },
  'vue-tsgo': {
    createCommandTarget: createVueTsgoCommandTarget,
    extensions: (options) =>
      resolveVueProjectExtensionsForChecker(options, 'vue-tsgo'),
    execution: 'typecheck',
    packageNames: ['vue-tsgo', '@typescript/native-preview'],
    parseProjectConfig: (options) => parseVueProjectConfig(options, 'vue-tsgo'),
    preset: 'vue-tsgo',
    resolveModuleName: resolveTypeScriptModuleName,
    sourceGraph: true,
  },
} satisfies Record<BuiltinCheckerPreset, CheckerAdapter>;

export function isBuiltinCheckerPreset(
  value: string,
): value is BuiltinCheckerPreset {
  return Object.hasOwn(builtinCheckerAdapters, value);
}

export function getCheckerAdapter(preset: string): CheckerAdapter | null {
  return isBuiltinCheckerPreset(preset) ? builtinCheckerAdapters[preset] : null;
}

function isVueCheckerPreset(preset: CheckerPreset): boolean {
  return preset === 'vue-tsc' || preset === 'vue-tsgo';
}

export function resolveCheckerPackageFromRoot(options: {
  packageName: string;
  projectRootDir: string;
}): string | undefined {
  const requireFromRoot = createRequire(
    path.join(options.projectRootDir, 'package.json'),
  );

  try {
    return requireFromRoot.resolve(`${options.packageName}/package.json`);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
    ) {
      return options.packageName;
    }

    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'MODULE_NOT_FOUND'
    ) {
      return undefined;
    }

    throw error;
  }
}

export function collectMissingCheckerPeerDependencies(options: {
  checkers: ResolvedCheckerConfig[];
  projectRootDir: string;
  resolvePackage?: CheckerPackageResolver;
}): MissingCheckerPeerDependency[] {
  const resolvePackage =
    options.resolvePackage ?? resolveCheckerPackageFromRoot;
  const missingCheckersByPackage = new Map<string, Set<string>>();

  for (const checker of options.checkers) {
    const packageNames = getCheckerAdapter(checker.preset)?.packageNames ?? [];

    for (const packageName of packageNames) {
      if (
        resolvePackage({
          packageName,
          projectRootDir: options.projectRootDir,
        })
      ) {
        continue;
      }

      const checkerNames =
        missingCheckersByPackage.get(packageName) ?? new Set<string>();

      checkerNames.add(checker.name);
      missingCheckersByPackage.set(packageName, checkerNames);
    }
  }

  return [...missingCheckersByPackage.entries()]
    .map(([packageName, checkerNames]) => ({
      checkerNames: [...checkerNames].sort((left, right) =>
        left.localeCompare(right),
      ),
      packageName,
    }))
    .sort((left, right) => left.packageName.localeCompare(right.packageName));
}

export function formatMissingCheckerPeerDependencies(
  missingDependencies: MissingCheckerPeerDependency[],
): string {
  const packageNames = missingDependencies.map(
    (dependency) => dependency.packageName,
  );

  return [
    'Missing checker peer dependencies:',
    ...missingDependencies.map((dependency) => {
      const checkerList = dependency.checkerNames
        .map((checkerName) => `"${checkerName}"`)
        .join(', ');

      return `  - ${dependency.packageName} (used by checker ${checkerList})`;
    }),
    `Fix: pnpm add -D ${packageNames.join(' ')}`,
  ].join('\n');
}

export function getCheckerExtensions(
  checker: CheckerConfig,
  options: { projectRootDir?: string } = {},
): string[] {
  const adapter = getCheckerAdapter(checker.preset);

  if (adapter) {
    if (isVueCheckerPreset(checker.preset)) {
      if (!options.projectRootDir) {
        throw new Error(
          [
            'Unable to resolve Vue checker extensions:',
            `  preset: ${checker.preset}`,
            '  reason: Vue checker extensions must be read from the checker API and require a resolved project root.',
          ].join('\n'),
        );
      }

      return adapter.extensions({
        configPath: normalizeAbsolutePath(
          path.resolve(options.projectRootDir, checker.entry),
        ),
        projectRootDir: options.projectRootDir,
      });
    }

    return adapter.extensions({
      configPath: normalizeAbsolutePath(
        path.resolve(options.projectRootDir ?? '', checker.entry),
      ),
      projectRootDir: options.projectRootDir ?? '',
    });
  }

  throw new Error(`Checker preset "${checker.preset}" is not supported.`);
}

export function getResolvedCheckers(config: {
  config?: { checkers?: Record<string, CheckerConfig> };
  rootDir?: string;
}): ResolvedCheckerConfig[] {
  const checkers = config.config?.checkers;

  if (!checkers) {
    return [];
  }

  return Object.entries(checkers)
    .map(([name, checker]) => ({
      entry: checker.entry.trim(),
      extensions: getCheckerExtensions(checker, {
        projectRootDir: config.rootDir,
      }),
      name,
      preset: checker.preset,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function normalizeExtensions(extensions: string[]): string[] {
  return [...new Set(extensions)].sort((left, right) => {
    const lengthDelta = right.length - left.length;

    return lengthDelta === 0 ? left.localeCompare(right) : lengthDelta;
  });
}
