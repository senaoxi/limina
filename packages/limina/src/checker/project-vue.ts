import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import { createRequire } from 'node:module';
import path from 'pathe';
import ts from 'typescript';
import {
  createExtraFileExtensions,
  getTypeScriptCheckerExtensions,
  normalizeExtensions,
} from './extensions';
import {
  createFormatHost,
  createParsedCheckerProjectConfig,
  createProjectParseHost,
} from './project-base';
import type {
  CheckerProjectConfigParseOptions,
  ParsedCheckerProjectConfig,
  VueLanguageCore,
} from './types';

function getErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (!('code' in error)) return undefined;
  return String(error.code);
}

function isModuleNotFoundError(error: unknown): boolean {
  return getErrorCode(error) === 'MODULE_NOT_FOUND';
}

function isPackagePathExportError(error: unknown): boolean {
  return getErrorCode(error) === 'ERR_PACKAGE_PATH_NOT_EXPORTED';
}

function recoverPackageRequire(options: {
  error: unknown;
  packageName: string;
  requireFromBase: ReturnType<typeof createRequire>;
}): ReturnType<typeof createRequire> | null {
  if (isPackagePathExportError(options.error)) {
    return createRequire(options.requireFromBase.resolve(options.packageName));
  }
  if (isModuleNotFoundError(options.error)) return null;
  throw options.error;
}

function createPackageRequireFromBase(options: {
  basePath: string;
  packageName: string;
}): ReturnType<typeof createRequire> | null {
  const requireFromBase = createRequire(options.basePath);
  try {
    return createRequire(
      requireFromBase.resolve(`${options.packageName}/package.json`),
    );
  } catch (error) {
    return recoverPackageRequire({
      error,
      packageName: options.packageName,
      requireFromBase,
    });
  }
}

function createRequireCandidate(options: {
  basePath: string;
  packageName: string;
  projectRootDir: string;
}): ReturnType<typeof createRequire> | null {
  return createPackageRequireFromBase(options);
}

function findRequireCandidate(
  candidates: readonly (ReturnType<typeof createRequire> | null)[],
): ReturnType<typeof createRequire> | null {
  return candidates.find((candidate) => candidate !== null) ?? null;
}

function getCheckerBasePaths(projectRootDir: string): string[] {
  return [path.join(projectRootDir, 'package.json'), import.meta.url];
}

function resolveRequireCandidates(options: {
  basePaths: readonly string[];
  packageName: string;
  projectRootDir: string;
}): ReturnType<typeof createRequire> | null {
  const candidates = options.basePaths.map((basePath) =>
    createRequireCandidate({ ...options, basePath }),
  );
  return findRequireCandidate(candidates);
}

function createCheckerPackageRequire(options: {
  packageName: string;
  projectRootDir: string;
}): ReturnType<typeof createRequire> | null {
  const basePaths = getCheckerBasePaths(options.projectRootDir);
  return resolveRequireCandidates({ ...options, basePaths });
}

function requireCheckerPackage(options: {
  packageName: string;
  projectRootDir: string;
}): ReturnType<typeof createRequire> {
  const checkerRequire = createCheckerPackageRequire(options);
  if (checkerRequire !== null) return checkerRequire;
  throw new Error(
    [
      'Unable to resolve Vue checker package:',
      `  package: ${options.packageName}`,
      `  root: ${options.projectRootDir}`,
    ].join('\n'),
  );
}

function getVueLanguageCore(options: {
  packageName: string;
  projectRootDir: string;
}): VueLanguageCore {
  const requireFromChecker = requireCheckerPackage(options);
  try {
    return requireFromChecker('@vue/language-core') as VueLanguageCore;
  } catch (error) {
    if (!isModuleNotFoundError(error)) throw error;
    throw new Error(
      [
        'Unable to resolve Vue checker language core:',
        `  checker package: ${options.packageName}`,
        '  required package: @vue/language-core',
      ].join('\n'),
    );
  }
}

function createVueParsedCommandLine(options: {
  configPath: string;
  packageName: string;
  projectRootDir: string;
  virtualFiles?: ReadonlyMap<string, string>;
}): {
  commandLine: ReturnType<VueLanguageCore['createParsedCommandLine']>;
  configPath: string;
  vueLanguageCore: VueLanguageCore;
} {
  const vueLanguageCore = getVueLanguageCore(options);
  const configPath = normalizeAbsolutePath(options.configPath);
  return {
    commandLine: vueLanguageCore.createParsedCommandLine(
      ts,
      createProjectParseHost(options.virtualFiles),
      configPath,
    ),
    configPath,
    vueLanguageCore,
  };
}

export function resolveVueProjectExtensions(
  options: CheckerProjectConfigParseOptions,
  packageName: string,
): string[] {
  const { commandLine, vueLanguageCore } = createVueParsedCommandLine({
    configPath: options.configPath,
    packageName,
    projectRootDir: options.projectRootDir,
    virtualFiles: options.virtualFiles,
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

function getConfiguredExtensions(
  options: CheckerProjectConfigParseOptions,
): string[] {
  return options.extensions === undefined ? [] : options.extensions;
}

export function resolveVueProjectExtensionsForChecker(
  options: CheckerProjectConfigParseOptions,
  packageName: string,
): string[] {
  return normalizeExtensions([
    ...getConfiguredExtensions(options),
    ...resolveVueProjectExtensions(options, packageName),
  ]);
}

function assertNoVueParseErrors(options: {
  errors: readonly ts.Diagnostic[];
  projectRootDir: string;
}): void {
  if (options.errors.length === 0) return;
  throw new Error(
    ts.formatDiagnosticsWithColorAndContext(
      options.errors,
      createFormatHost(options.projectRootDir),
    ),
  );
}

export function parseVueProjectConfig(
  options: CheckerProjectConfigParseOptions,
  packageName: string,
): ParsedCheckerProjectConfig {
  const { commandLine, configPath, vueLanguageCore } =
    createVueParsedCommandLine({
      configPath: options.configPath,
      packageName,
      projectRootDir: options.projectRootDir,
      virtualFiles: options.virtualFiles,
    });
  const extensions = normalizeExtensions([
    ...getConfiguredExtensions(options),
    ...getTypeScriptCheckerExtensions(),
    ...vueLanguageCore.getAllExtensions(commandLine.vueOptions),
  ]);
  const host = createProjectParseHost(options.virtualFiles);
  const configFile = ts.readJsonConfigFile(configPath, host.readFile);
  const parsed = ts.parseJsonSourceFileConfigFileContent(
    configFile,
    host,
    path.dirname(configPath),
    {},
    configPath,
    undefined,
    createExtraFileExtensions(extensions),
  );
  assertNoVueParseErrors({
    errors: parsed.errors,
    projectRootDir: options.projectRootDir,
  });
  return createParsedCheckerProjectConfig({
    extensions,
    fileNames: parsed.fileNames,
    parsed,
  });
}
