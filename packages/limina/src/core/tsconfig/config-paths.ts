import type { ResolvedLiminaConfig } from '#config/runner';
import { normalizeAbsolutePath, toPosixPath } from '#utils/path';
import { isPlainRecord } from '#utils/values';
import { existsSync, statSync } from 'node:fs';
import path from 'pathe';
import ts from 'typescript';
import type { JsonObject } from './action-types';

const removedRootLiminaMetadataError = [
  'Invalid Limina tsconfig metadata:',
  '  field: limina',
  '  reason: root-level limina metadata is not part of the Limina 0.2.0 tsconfig contract.',
].join('\n');

const dtsConfigFilePattern = /^tsconfig(?:\..+)?\.dts\.json$/u;
const buildGraphConfigFilePattern = /^tsconfig(?:\..+)?\.build\.json$/u;
const baseConfigFilePattern = /^tsconfig(?:\..+)?\.base\.json$/u;
const checkConfigFilePattern = /^tsconfig(?:\..+)?\.check\.json$/u;
const tsconfigFilePattern = /^tsconfig(?:\..+)?\.json$/u;
// eslint-disable-next-line regexp/no-useless-assertions -- Empty extension sets must match no paths.
const neverMatchingPattern = new RegExp(String.fromCodePoint(97, 94), 'u');
const liminaTsconfigSchemaPath = [
  'node_modules',
  'limina',
  'schemas',
  'tsconfig-schema.json',
] as const;

function createFormatHost(rootDir: string): ts.FormatDiagnosticsHost {
  return {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => rootDir,
    getNewLine: () => '\n',
  };
}

function readVirtualOrDiskFile(
  fileName: string,
  virtualFiles: ReadonlyMap<string, string> | undefined,
): string | undefined {
  if (virtualFiles === undefined) {
    return ts.sys.readFile(fileName);
  }
  const virtualContent = virtualFiles.get(normalizeAbsolutePath(fileName));
  return virtualContent === undefined
    ? ts.sys.readFile(fileName)
    : virtualContent;
}

export function readJsonConfigFile(
  rootDir: string,
  configPath: string,
  virtualFiles?: ReadonlyMap<string, string>,
): JsonObject {
  const result = ts.readConfigFile(configPath, (fileName) =>
    readVirtualOrDiskFile(fileName, virtualFiles),
  );
  if (result.error !== undefined) {
    throw new Error(
      ts.formatDiagnostic(result.error, createFormatHost(rootDir)),
    );
  }
  return result.config as JsonObject;
}

export function createLiminaTsconfigSchemaPath(
  rootDir: string,
  configPath: string,
): string {
  const relativePath = toPosixPath(
    path.relative(
      path.dirname(configPath),
      path.join(rootDir, ...liminaTsconfigSchemaPath),
    ),
  );
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

export function createExtensionPattern(extensions: string[]): RegExp {
  if (extensions.length === 0) {
    return neverMatchingPattern;
  }
  return new RegExp(
    `(?:${extensions
      .sort((left, right) => right.length - left.length)
      .map(escapeRegExp)
      .join('|')})$`,
    'u',
  );
}

function isGeneratedLiminaConfigPath(configPath: string): boolean {
  return configPath.split(/[\\/]/u).includes('.limina');
}

export function validateUserMaintainedLiminaTsconfigMetadata(options: {
  configObject: JsonObject;
  configPath: string;
}): void {
  if (isGeneratedLiminaConfigPath(options.configPath)) {
    return;
  }
  if (Object.hasOwn(options.configObject, 'limina')) {
    throw new Error(removedRootLiminaMetadataError);
  }
}

export function readJsonConfig(
  config: ResolvedLiminaConfig,
  configPath: string,
  virtualFiles?: ReadonlyMap<string, string>,
): JsonObject {
  return readJsonConfigFile(config.rootDir, configPath, virtualFiles);
}

function createProjectConfigCandidate(
  baseDirectory: string,
  value: string | undefined,
): string {
  if (value === undefined) {
    return path.join(baseDirectory, 'tsconfig.json');
  }
  return path.resolve(baseDirectory, value);
}

function isExistingDirectory(candidate: string): boolean {
  return existsSync(candidate) && statSync(candidate).isDirectory();
}

export function resolveProjectConfigPath(
  baseDirectory: string,
  value?: string,
): string {
  const candidate = createProjectConfigCandidate(baseDirectory, value);
  const resolved = isExistingDirectory(candidate)
    ? path.join(candidate, 'tsconfig.json')
    : candidate;
  return normalizeAbsolutePath(resolved);
}

export function resolveReferencePath(
  configPath: string,
  referencePath: string,
): string {
  const absoluteReferencePath = path.resolve(
    path.dirname(configPath),
    referencePath,
  );
  if (path.extname(absoluteReferencePath) === '.json') {
    return normalizeAbsolutePath(absoluteReferencePath);
  }
  return normalizeAbsolutePath(
    path.join(absoluteReferencePath, 'tsconfig.json'),
  );
}

export function isDtsConfigPath(configPath: string): boolean {
  return dtsConfigFilePattern.test(path.basename(configPath));
}

function readSourceConfigValue(configObject: JsonObject): unknown {
  const liminaOptions = configObject.liminaOptions;
  if (!isPlainRecord(liminaOptions)) {
    return undefined;
  }
  return liminaOptions.sourceConfig;
}

export function getDtsCompanionConfigPath(dtsConfigPath: string): string {
  const configObject = readJsonConfigFile(
    path.dirname(dtsConfigPath),
    dtsConfigPath,
  );
  const sourceConfig = readSourceConfigValue(configObject);
  if (typeof sourceConfig === 'string' && sourceConfig.trim().length > 0) {
    return resolveReferencePath(dtsConfigPath, sourceConfig);
  }
  throw new Error(
    [
      'Generated declaration config is missing its source config metadata:',
      `  config: ${dtsConfigPath}`,
      '  field: liminaOptions.sourceConfig',
      '  reason: Limina no longer infers source companions from source-level tsconfig*.dts.json files.',
    ].join('\n'),
  );
}

export function isBuildGraphConfigPath(configPath: string): boolean {
  return buildGraphConfigFilePattern.test(path.basename(configPath));
}

function matchesReservedTypeScriptConfig(fileName: string): boolean {
  return [
    dtsConfigFilePattern,
    buildGraphConfigFilePattern,
    baseConfigFilePattern,
    checkConfigFilePattern,
  ].some((pattern) => pattern.test(fileName));
}

export function isOrdinaryTypecheckConfigPath(configPath: string): boolean {
  const fileName = path.basename(configPath);
  return (
    tsconfigFilePattern.test(fileName) &&
    !matchesReservedTypeScriptConfig(fileName)
  );
}

export function isOrdinarySourceTypecheckConfigPath(
  configPath: string,
): boolean {
  if (!isOrdinaryTypecheckConfigPath(configPath)) {
    return false;
  }
  return !configPath.split(path.sep).includes('.limina');
}
