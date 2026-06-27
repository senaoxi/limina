import type {
  BuiltinCheckerPreset,
  CheckerConfig,
  CheckerExecutionKind,
  CheckerPreset,
  ResolvedCheckerConfig,
} from '#config/runner';
import { uniqueSortedStrings, uniqueValues } from '#utils/collections';
import {
  candidatePathsForBasePath,
  resolveExistingFilePath,
  resolvePathMappedModuleCandidate,
  resolveRelativeModuleCandidate,
} from '#utils/module-resolution';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'pathe';
import ts from 'typescript';

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

export function getBuildCheckerSupportedExtensions(
  preset: CheckerPreset,
): string[] {
  const adapter = getCheckerAdapter(preset);

  if (!adapter || adapter.execution !== 'build') {
    return [];
  }

  const nativeExtensions = getNativeTypeScriptProjectExtensions();

  return preset === 'vue-tsc'
    ? normalizeExtensions([...nativeExtensions, '.vue'])
    : nativeExtensions;
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
  watch?: boolean;
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

export interface ResolvedCheckerModuleName {
  isExternalLibraryImport: boolean;
  resolvedBy: 'checker-extension' | 'typescript';
  resolvedFileName: string;
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
  reason?: string;
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

const parsedProjectConfigCache = new Map<string, ParsedCheckerProjectConfig>();

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

function cloneParsedCheckerProjectConfig(
  parsedConfig: ParsedCheckerProjectConfig,
): ParsedCheckerProjectConfig {
  return {
    extensions: [...parsedConfig.extensions],
    fileNames: [...parsedConfig.fileNames],
    options: { ...parsedConfig.options },
  };
}

function resolveContextCheckerPresets(
  context: CheckerProjectParseContext,
): CheckerPreset[] {
  return context.checkerPresets.length > 0
    ? (uniqueSortedStrings(context.checkerPresets) as CheckerPreset[])
    : (['tsc'] satisfies CheckerPreset[]);
}

function createParsedProjectConfigCacheKey(options: {
  checkerPresets: CheckerPreset[];
  configPath: string;
  extensions: string[];
  projectRootDir: string;
}): string {
  const configStat = statSync(options.configPath);

  return JSON.stringify({
    checkerPresets: options.checkerPresets,
    configPath: normalizeAbsolutePath(options.configPath),
    configSize: configStat.size,
    configTime: configStat.mtimeMs,
    extensions: normalizeExtensions(options.extensions),
    projectRootDir: normalizeAbsolutePath(options.projectRootDir),
  });
}

export function clearCheckerProjectConfigCache(): void {
  parsedProjectConfigCache.clear();
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
      extension: extension.startsWith('.') ? extension.slice(1) : extension,
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

function createVueParsedCommandLine(options: {
  configPath: string;
  packageName: string;
  projectRootDir: string;
}): {
  commandLine: ReturnType<VueLanguageCore['createParsedCommandLine']>;
  configPath: string;
  vueLanguageCore: VueLanguageCore;
} {
  const vueLanguageCore = getVueLanguageCore({
    packageName: options.packageName,
    projectRootDir: options.projectRootDir,
  });
  const configPath = normalizeAbsolutePath(options.configPath);

  return {
    commandLine: vueLanguageCore.createParsedCommandLine(
      ts,
      ts.sys,
      configPath,
    ),
    configPath,
    vueLanguageCore,
  };
}

function resolveVueProjectExtensions(
  options: CheckerProjectConfigParseOptions,
  packageName: string,
): string[] {
  const { commandLine, vueLanguageCore } = createVueParsedCommandLine({
    configPath: options.configPath,
    packageName,
    projectRootDir: options.projectRootDir,
  });

  try {
    return normalizeExtensions([
      ...getTypeScriptCheckerExtensions(),
      ...vueLanguageCore.getAllExtensions(commandLine.vueOptions),
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
  const { commandLine, configPath, vueLanguageCore } =
    createVueParsedCommandLine({
      configPath: options.configPath,
      packageName,
      projectRootDir: options.projectRootDir,
    });
  const extensions = normalizeExtensions([
    ...(options.extensions ?? []),
    ...getTypeScriptCheckerExtensions(),
    ...vueLanguageCore.getAllExtensions(commandLine.vueOptions),
  ]);
  const configFile = ts.readJsonConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonSourceFileConfigFileContent(
    configFile,
    ts.sys,
    path.dirname(configPath),
    {},
    configPath,
    undefined,
    createExtraFileExtensions(extensions),
  );
  const errors = parsed.errors;

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

function resolveTypeScriptModuleName(
  options: CheckerModuleResolveOptions,
): string | null {
  return resolveTypeScriptModuleNameDetailed(options)?.resolvedFileName ?? null;
}

function resolveTypeScriptModuleNameDetailed(
  options: CheckerModuleResolveOptions,
): ResolvedCheckerModuleName | null {
  const resolved = ts.resolveModuleName(
    options.specifier,
    options.containingFile,
    options.compilerOptions,
    ts.sys,
  ).resolvedModule;

  if (resolved?.resolvedFileName) {
    return {
      isExternalLibraryImport: resolved.isExternalLibraryImport === true,
      resolvedBy: 'typescript',
      resolvedFileName: normalizeAbsolutePath(resolved.resolvedFileName),
    };
  }

  return resolveCheckerExtensionModuleName(options);
}

function resolveCheckerExtensionModuleName(
  options: CheckerModuleResolveOptions,
): ResolvedCheckerModuleName | null {
  const typeScriptExtensions = new Set(getTypeScriptCheckerExtensions());
  const checkerOnlyExtensions = options.extensions.filter(
    (extension) => !typeScriptExtensions.has(extension),
  );

  if (checkerOnlyExtensions.length === 0) {
    return null;
  }

  const resolvedFileName =
    resolveRelativeModuleCandidate({
      containingFile: options.containingFile,
      extensions: checkerOnlyExtensions,
      specifier: options.specifier,
    }) ??
    resolvePathMappedModuleCandidate({
      compilerOptions: options.compilerOptions,
      extensions: checkerOnlyExtensions,
      specifier: options.specifier,
    }) ??
    resolvePackageExportModuleCandidate({
      containingFile: options.containingFile,
      extensions: checkerOnlyExtensions,
      specifier: options.specifier,
    });

  return resolvedFileName
    ? {
        isExternalLibraryImport: false,
        resolvedBy: 'checker-extension',
        resolvedFileName,
      }
    : null;
}

function resolvePackageExportModuleCandidate(options: {
  containingFile: string;
  extensions: readonly string[];
  specifier: string;
}): string | null {
  const specifierParts = parsePackageSpecifier(options.specifier);

  if (!specifierParts) {
    return null;
  }

  const packageDirectory = findPackageDirectoryForImport({
    containingFile: options.containingFile,
    packageName: specifierParts.packageName,
  });

  if (!packageDirectory) {
    return null;
  }

  const manifest = readPackageManifest(packageDirectory);
  const targets = collectExportTargetsForSubpath(
    manifest?.exports,
    specifierParts.subpath,
  );

  for (const target of targets) {
    if (!target.startsWith('./')) {
      continue;
    }

    const targetPath = path.resolve(packageDirectory, target.slice(2));

    for (const candidatePath of candidatePathsForBasePath(
      targetPath,
      options.extensions,
    )) {
      const resolvedPath = resolveExistingFilePath(candidatePath);

      if (resolvedPath) {
        return resolvedPath;
      }
    }
  }

  return null;
}

function parsePackageSpecifier(
  specifier: string,
): { packageName: string; subpath: string } | null {
  if (
    specifier.length === 0 ||
    specifier.startsWith('.') ||
    specifier.startsWith('/')
  ) {
    return null;
  }

  const parts = specifier.split('/');

  if (specifier.startsWith('@')) {
    const scope = parts[0];
    const name = parts[1];

    if (!scope || !name) {
      return null;
    }

    return {
      packageName: `${scope}/${name}`,
      subpath: parts.length > 2 ? `./${parts.slice(2).join('/')}` : '.',
    };
  }

  const packageName = parts[0];

  return packageName
    ? {
        packageName,
        subpath: parts.length > 1 ? `./${parts.slice(1).join('/')}` : '.',
      }
    : null;
}

function findPackageDirectoryForImport(options: {
  containingFile: string;
  packageName: string;
}): string | null {
  let currentDir = path.dirname(options.containingFile);

  for (;;) {
    const packageDirectory = path.join(
      currentDir,
      'node_modules',
      options.packageName,
    );

    if (existsSync(path.join(packageDirectory, 'package.json'))) {
      return packageDirectory;
    }

    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

function readPackageManifest(
  packageDirectory: string,
): { exports?: unknown } | null {
  try {
    return JSON.parse(
      readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'),
    ) as { exports?: unknown };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function collectStringTargets(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectStringTargets);
  }

  if (isRecord(value)) {
    return Object.values(value).flatMap(collectStringTargets);
  }

  return [];
}

function collectExportTargetsForSubpath(
  exportsField: unknown,
  subpath: string,
): string[] {
  if (exportsField === undefined) {
    return subpath === '.' ? ['./index'] : [subpath];
  }

  if (typeof exportsField === 'string' || Array.isArray(exportsField)) {
    return subpath === '.' ? collectStringTargets(exportsField) : [];
  }

  if (!isRecord(exportsField)) {
    return [];
  }

  const isSubpathExportMap = Object.keys(exportsField).some(
    (key) => key === '.' || key.startsWith('./'),
  );

  if (!isSubpathExportMap) {
    return subpath === '.' ? collectStringTargets(exportsField) : [];
  }

  return collectStringTargets(exportsField[subpath]);
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
    fileNames: uniqueSortedStrings(
      parsedConfigs.flatMap((parsedConfig) => parsedConfig.fileNames),
    ),
    options: firstConfig.options,
  };
}

export function parseCheckerProjectConfigForContext(options: {
  configPath: string;
  context: CheckerProjectParseContext;
  projectRootDir: string;
}): ParsedCheckerProjectConfig {
  const checkerPresets = resolveContextCheckerPresets(options.context);
  const cacheKey = createParsedProjectConfigCacheKey({
    checkerPresets,
    configPath: options.configPath,
    extensions: options.context.extensions,
    projectRootDir: options.projectRootDir,
  });
  const cached = parsedProjectConfigCache.get(cacheKey);

  if (cached) {
    return cloneParsedCheckerProjectConfig(cached);
  }

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
  const parsedConfig = mergeParsedProjectConfigs(
    parsedConfigs,
    options.context.extensions,
  );

  parsedProjectConfigCache.set(
    cacheKey,
    cloneParsedCheckerProjectConfig(parsedConfig),
  );

  return cloneParsedCheckerProjectConfig(parsedConfig);
}

export function resolveModuleNameWithCheckers(options: {
  compilerOptions: ts.CompilerOptions;
  containingFile: string;
  context: CheckerProjectParseContext;
  specifier: string;
}): string | null {
  return (
    resolveModuleNameWithCheckersDetailed(options)?.resolvedFileName ?? null
  );
}

export function resolveModuleNameWithCheckersDetailed(options: {
  compilerOptions: ts.CompilerOptions;
  containingFile: string;
  context: CheckerProjectParseContext;
  specifier: string;
}): ResolvedCheckerModuleName | null {
  const checkerPresets =
    options.context.checkerPresets.length > 0
      ? options.context.checkerPresets
      : (['tsc'] satisfies CheckerPreset[]);

  for (const preset of checkerPresets) {
    const adapter = getCheckerAdapter(preset);

    if (!adapter) {
      continue;
    }

    const resolved = resolveTypeScriptModuleNameDetailed({
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
    args: [
      '-b',
      relativeConfigPath,
      '--pretty',
      'false',
      ...(options.watch ? ['--watch', '--preserveWatchOutput'] : []),
    ],
    command: options.commandOverride ?? 'tsc',
    label: `tsc -b ${relativeConfigPath}${options.watch ? ' --watch' : ''}`,
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
    args: [
      '-b',
      relativeConfigPath,
      '--pretty',
      'false',
      ...(options.watch ? ['--watch', '--preserveWatchOutput'] : []),
    ],
    command: 'tsgo',
    label: `tsgo -b ${relativeConfigPath}${options.watch ? ' --watch' : ''}`,
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
    args: [
      '-b',
      relativeConfigPath,
      '--pretty',
      'false',
      ...(options.watch ? ['--watch', '--preserveWatchOutput'] : []),
    ],
    command: 'vue-tsc',
    label: `${options.checker.name}: vue-tsc -b ${relativeConfigPath}${options.watch ? ' --watch' : ''}`,
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
    packageNames: ['vue-tsc'],
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

function isBuiltinCheckerPreset(value: string): value is BuiltinCheckerPreset {
  return Object.hasOwn(builtinCheckerAdapters, value);
}

export function getCheckerAdapter(preset: string): CheckerAdapter | null {
  return isBuiltinCheckerPreset(preset) ? builtinCheckerAdapters[preset] : null;
}

function isVueCheckerPreset(preset: CheckerPreset): boolean {
  return preset === 'vue-tsc' || preset === 'vue-tsgo';
}

function resolveCheckerPackageFromRoot(options: {
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
      const reason = dependency.reason ? `; ${dependency.reason}` : '';

      return `  - ${dependency.packageName} (used by checker ${checkerList}${reason})`;
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
      return normalizeExtensions([...getTypeScriptCheckerExtensions(), '.vue']);
    }

    return adapter.extensions({
      configPath: normalizeAbsolutePath(
        path.resolve(options.projectRootDir ?? '', 'tsconfig.json'),
      ),
      projectRootDir: options.projectRootDir ?? '',
    });
  }

  throw new Error(`Checker preset "${checker.preset}" is not supported.`);
}

export function getResolvedCheckers(config: {
  config?: {
    checkers?:
      | { exclude?: string[]; mode: 'auto' }
      | Record<string, CheckerConfig>;
  };
  rootDir?: string;
}): ResolvedCheckerConfig[] {
  const checkers = config.config?.checkers;

  if (!checkers || checkers.mode === 'auto') {
    return [];
  }

  const checkerMap = checkers as Record<string, CheckerConfig>;

  return Object.entries(checkerMap)
    .map(([name, checker]) => ({
      exclude: (checker.exclude ?? []).map((value) => value.trim()),
      extensions: getCheckerExtensions(checker, {
        projectRootDir: config.rootDir,
      }),
      include: checker.include.map((value) => value.trim()),
      name,
      preset: checker.preset,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function normalizeExtensions(extensions: string[]): string[] {
  return uniqueValues(extensions).sort((left, right) => {
    const lengthDelta = right.length - left.length;

    return lengthDelta === 0 ? left.localeCompare(right) : lengthDelta;
  });
}
