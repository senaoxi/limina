import {
  type CheckerProjectConfigCache,
  type CheckerProjectParseContext,
  parseCheckerProjectConfigForContext,
} from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import {
  getDtsCompanionConfigPath,
  type JsonObject,
  readJsonConfig,
  resolveReferencePath,
  validateUserMaintainedLiminaTsconfigMetadata,
} from '#core/tsconfig/actions';
import { normalizeAbsolutePath } from '#utils/path';
import { existsSync } from 'node:fs';
import path from 'pathe';
import type ts from 'typescript';
import { isPlainRecord } from './config-values';

export interface ParsedProofConfig {
  fileNames: string[];
  options: ts.CompilerOptions;
}

export const ignoredSemanticCompilerOptions: ReadonlySet<string> = new Set([
  'baseUrl',
  'build',
  'composite',
  'configFilePath',
  'declaration',
  'declarationDir',
  'declarationMap',
  'emitBOM',
  'emitDeclarationOnly',
  'incremental',
  'inlineSourceMap',
  'inlineSources',
  'mapRoot',
  'newLine',
  'noEmit',
  'noEmitOnError',
  'out',
  'outDir',
  'outFile',
  'paths',
  'pathsBasePath',
  'preserveConstEnums',
  'project',
  'removeComments',
  'rewriteRelativeImportExtensions',
  'rootDir',
  'showConfig',
  'sourceMap',
  'sourceRoot',
  'tsBuildInfoFile',
  'typeRoots',
]);

export function parseProofConfig(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  context?: CheckerProjectParseContext;
  projectConfigCache?: CheckerProjectConfigCache;
  virtualFiles?: ReadonlyMap<string, string>;
}): ParsedProofConfig {
  const context = options.context ?? {
    checkerPresets: [],
    extensions: [],
  };
  const parsed = parseCheckerProjectConfigForContext({
    cache: options.projectConfigCache,
    configPath: options.configPath,
    context,
    projectRootDir: options.config.rootDir,
    virtualFiles: options.virtualFiles,
  });

  return {
    fileNames: parsed.fileNames.map(normalizeAbsolutePath).sort(),
    options: parsed.options,
  };
}

export function readProofConfig(
  config: ResolvedLiminaConfig,
  configPath: string,
  virtualFiles?: ReadonlyMap<string, string>,
): JsonObject {
  const content = virtualFiles?.get(normalizeAbsolutePath(configPath));
  const configObject = content
    ? (JSON.parse(content) as JsonObject)
    : readJsonConfig(config, configPath);

  validateUserMaintainedLiminaTsconfigMetadata({ configObject, configPath });

  return configObject;
}

function getSourceConfigMetadata(configObject: JsonObject): unknown {
  if (!isPlainRecord(configObject.liminaOptions)) {
    return undefined;
  }

  return configObject.liminaOptions.sourceConfig;
}

export function getProofCompanionConfigPath(
  configPath: string,
  virtualFiles: ReadonlyMap<string, string>,
): string {
  const configObject = readProofConfig(
    { rootDir: path.dirname(configPath) } as ResolvedLiminaConfig,
    configPath,
    virtualFiles,
  );
  const sourceConfig = getSourceConfigMetadata(configObject);

  if (typeof sourceConfig === 'string') {
    return resolveReferencePath(configPath, sourceConfig);
  }

  return getDtsCompanionConfigPath(configPath);
}

function getCompilerOptionTypes(configObject: JsonObject): unknown {
  if (!isPlainRecord(configObject.compilerOptions)) {
    return undefined;
  }

  return configObject.compilerOptions.types;
}

function isRelativeTypeName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value.startsWith('./') || value.startsWith('../'))
  );
}

export function readRelativeTypeFiles(
  config: ResolvedLiminaConfig,
  sourceConfigPath: string,
): string[] {
  const types = getCompilerOptionTypes(
    readProofConfig(config, sourceConfigPath),
  );

  if (!Array.isArray(types)) {
    return [];
  }

  return types
    .filter(isRelativeTypeName)
    .map((typeName) =>
      normalizeAbsolutePath(
        path.resolve(path.dirname(sourceConfigPath), typeName),
      ),
    );
}

export function normalizeGeneratedDtsTypes(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }

  return value.filter((typeName) => !isRelativeTypeName(typeName));
}

export function formatJsonValue(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function normalizeCompilerOptionObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeCompilerOptionValue(value: unknown): unknown {
  return isRecordValue(value) ? normalizeCompilerOptionObject(value) : value;
}

export function normalizeRawExtends(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === 'string');
}

export function resolveRawExtendsPath(
  configPath: string,
  rawExtends: string,
): string {
  const resolvedPath = path.resolve(path.dirname(configPath), rawExtends);
  const withExtension = path.extname(resolvedPath)
    ? resolvedPath
    : `${resolvedPath}.json`;

  return normalizeAbsolutePath(withExtension);
}

function collectDirectExtendsPaths(
  configPath: string,
  configObject: JsonObject,
): string[] {
  return normalizeRawExtends(configObject.extends).map((entry) =>
    resolveRawExtendsPath(configPath, entry),
  );
}

function appendParentExtends(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  pending: string[];
  visited: Set<string>;
}): void {
  if (options.visited.has(options.configPath)) {
    return;
  }

  if (!existsSync(options.configPath)) {
    return;
  }

  options.visited.add(options.configPath);
  options.pending.push(
    ...collectDirectExtendsPaths(
      options.configPath,
      readProofConfig(options.config, options.configPath),
    ),
  );
}

export function configExtendsPathTransitively(options: {
  config: ResolvedLiminaConfig;
  configObject: JsonObject;
  configPath: string;
  targetConfigPath: string;
}): boolean {
  const visited = new Set([options.configPath]);
  const pending = collectDirectExtendsPaths(
    options.configPath,
    options.configObject,
  );

  for (const configPath of pending) {
    if (configPath === options.targetConfigPath) {
      return true;
    }

    appendParentExtends({
      config: options.config,
      configPath,
      pending,
      visited,
    });
  }

  return false;
}
