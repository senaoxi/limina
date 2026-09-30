import type { ResolvedLiminaConfig } from '#config/runner';
import { normalizeAbsolutePath, toPosixPath } from '#utils/path';
import { isPlainRecord } from '#utils/values';
import { existsSync, statSync } from 'node:fs';
import path from 'pathe';
import ts from 'typescript';
import type { JsonObject } from './action-types';

export class TsconfigInputError extends Error {}

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

function createFormatHost(rootDirectory: string): ts.FormatDiagnosticsHost {
  return {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => rootDirectory,
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
  rootDirectory: string,
  configPath: string,
  virtualFiles?: ReadonlyMap<string, string>,
): JsonObject {
  const result = ts.readConfigFile(configPath, (fileName) =>
    readVirtualOrDiskFile(fileName, virtualFiles),
  );
  if (result.error !== undefined) {
    throw new TsconfigInputError(
      ts.formatDiagnostic(result.error, createFormatHost(rootDirectory)),
    );
  }
  return result.config as JsonObject;
}

export function createLiminaTsconfigSchemaPath(
  rootDirectory: string,
  configPath: string,
): string {
  const relativePath = toPosixPath(
    path.relative(
      path.dirname(configPath),
      path.join(rootDirectory, ...liminaTsconfigSchemaPath),
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

export function isLiminaArtifactPath(
  configPath: string,
  rootDirectory: string,
): boolean {
  const candidatePath = path.relative(rootDirectory, configPath);
  return candidatePath.split(/[\\/]/u).includes('.limina');
}

export function validateUserMaintainedLiminaTsconfigMetadata(options: {
  configObject: JsonObject;
  configPath: string;
  rootDir: string;
}): void {
  if (isLiminaArtifactPath(options.configPath, options.rootDir)) {
    return;
  }
  if (Object.hasOwn(options.configObject, 'limina')) {
    throw new TsconfigInputError(removedRootLiminaMetadataError);
  }
}

export function readJsonConfig(
  config: ResolvedLiminaConfig,
  configPath: string,
  virtualFiles?: ReadonlyMap<string, string>,
): JsonObject {
  return readJsonConfigFile(
    config.rootDir,
    configPath,
    virtualFiles ?? config.virtualFiles,
  );
}

function createProjectConfigCandidate(
  baseDirectory: string,
  value: string | undefined,
): string {
  return value === undefined
    ? path.join(baseDirectory, 'tsconfig.json')
    : path.resolve(baseDirectory, value);
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
  return normalizeAbsolutePath(
    path.extname(absoluteReferencePath) === '.json'
      ? absoluteReferencePath
      : path.join(absoluteReferencePath, 'tsconfig.json'),
  );
}

export function isDtsConfigPath(configPath: string): boolean {
  return dtsConfigFilePattern.test(path.basename(configPath));
}

function readSourceConfigValue(configObject: JsonObject): unknown {
  const liminaOptions = configObject.liminaOptions;
  return isPlainRecord(liminaOptions) ? liminaOptions.sourceConfig : undefined;
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

function isMatchesReservedTypeScriptConfig(fileName: string): boolean {
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
    !isMatchesReservedTypeScriptConfig(fileName)
  );
}

export function isOrdinarySourceTypecheckConfigPath(
  configPath: string,
  rootDirectory: string,
): boolean {
  return (
    isOrdinaryTypecheckConfigPath(configPath) &&
    !isLiminaArtifactPath(configPath, rootDirectory)
  );
}
