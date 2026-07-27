import type { ResolvedLiminaConfig } from '#config/runner';
import {
  isOrdinarySourceTypecheckConfigPath,
  readJsonConfig,
} from '#core/tsconfig/actions';
import { uniqueValues } from '#utils/collections';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import { isPlainRecord } from '#utils/values';
import { existsSync } from 'node:fs';
import path from 'pathe';

export function isDefaultTsconfigPath(configPath: string): boolean {
  return path.basename(configPath) === 'tsconfig.json';
}

export function isDefaultSourceTsconfigPath(configPath: string): boolean {
  return (
    isOrdinarySourceTypecheckConfigPath(configPath) &&
    isDefaultTsconfigPath(configPath)
  );
}

function hasEmptyFiles(configObject: Record<string, unknown>): boolean {
  return Array.isArray(configObject.files) && configObject.files.length === 0;
}

export function isSolutionStyleTsconfig(
  configPath: string,
  configObject: Record<string, unknown>,
): boolean {
  return (
    isDefaultTsconfigPath(configPath) &&
    hasEmptyFiles(configObject) &&
    Object.hasOwn(configObject, 'references')
  );
}

function getGraphRulesValue(configObject: Record<string, unknown>): unknown {
  const options = configObject.liminaOptions;
  return isPlainRecord(options) ? options.graphRules : undefined;
}

function isGraphRuleLabel(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function readGraphRules(
  config: ResolvedLiminaConfig,
  sourceConfigPath: string,
): string[] {
  const graphRules = getGraphRulesValue(
    readJsonConfig(config, sourceConfigPath),
  );
  if (!Array.isArray(graphRules)) {
    return [];
  }

  return uniqueValues(graphRules.filter(isGraphRuleLabel)).map((label) =>
    label.trim(),
  );
}

export function addSourceReferenceConfigProblems(options: {
  config: ResolvedLiminaConfig;
  problems: string[];
  sourceConfigPath: string;
}): void {
  const configObject = readJsonConfig(options.config, options.sourceConfigPath);
  if (!Object.hasOwn(configObject, 'references')) {
    return;
  }

  if (isSolutionStyleTsconfig(options.sourceConfigPath, configObject)) {
    return;
  }

  options.problems.push(
    [
      'Source typecheck config declares project references:',
      `  config: ${toRelativePath(options.config.rootDir, options.sourceConfigPath)}`,
      '  field: references',
      '  reason: source typecheck configs must not hand-maintain project references; Limina infers static source edges and liminaOptions.implicitRefs documents dynamic or virtual edges.',
      '  fix: remove obsolete tsc -b references from source configs, move IDE aggregation references to a files: [] solution tsconfig.json, or replace dynamic source edges with liminaOptions.implicitRefs.',
    ].join('\n'),
  );
}

function getConfiguredTypes(configObject: Record<string, unknown>): unknown[] {
  const compilerOptions = configObject.compilerOptions;
  if (!isPlainRecord(compilerOptions)) {
    return [];
  }

  return Array.isArray(compilerOptions.types) ? compilerOptions.types : [];
}

function isRelativeTypeName(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  return value.startsWith('./') || value.startsWith('../');
}

export function readRelativeTypeFiles(
  config: ResolvedLiminaConfig,
  sourceConfigPath: string,
): string[] {
  return getConfiguredTypes(readJsonConfig(config, sourceConfigPath))
    .filter(isRelativeTypeName)
    .map((typeName) =>
      normalizeAbsolutePath(
        path.resolve(path.dirname(sourceConfigPath), typeName),
      ),
    );
}

function isTraversalBoundary(currentDir: string, rootDir: string): boolean {
  return currentDir === rootDir || path.dirname(currentDir) === currentDir;
}

function collectAncestorDirectories(
  sourceConfigPath: string,
  rootDir: string,
): string[] {
  const directories: string[] = [];
  let currentDir = path.dirname(sourceConfigPath);

  while (true) {
    directories.push(currentDir);
    if (isTraversalBoundary(currentDir, rootDir)) {
      return directories;
    }
    currentDir = path.dirname(currentDir);
  }
}

function getTypeRootCandidates(directory: string): string[] {
  const nodeModulesDir = path.join(directory, 'node_modules');
  return [nodeModulesDir, path.join(nodeModulesDir, '@types')];
}

export function collectTypeRootCandidates(options: {
  rootDir: string;
  sourceConfigPath: string;
}): string[] {
  const candidates = collectAncestorDirectories(
    options.sourceConfigPath,
    options.rootDir,
  ).flatMap(getTypeRootCandidates);
  return uniqueValues(candidates.filter(existsSync));
}
