import type { BuildCheckerPreset, ResolvedCheckerConfig } from '#config/runner';
import { resolveProjectConfigPath } from '#core/tsconfig/actions';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  toRelativePath,
} from '#utils/path';
import { existsSync, statSync } from 'node:fs';
import path from 'pathe';

function getParentDirectory(directory: string): string | null {
  const parent = path.dirname(directory);
  return parent === directory ? null : parent;
}

function getExistingDefaultConfig(directory: string): string | null {
  const candidatePath = path.join(directory, 'tsconfig.json');
  if (!existsSync(candidatePath)) return null;
  return normalizeAbsolutePath(candidatePath);
}

function continueNearestSearch(options: {
  parent: string | null;
  rootDir: string;
}): string | null {
  if (options.parent === null) return null;
  return findNearestAt({
    currentDir: options.parent,
    rootDir: options.rootDir,
  });
}

function findNearestAt(options: {
  currentDir: string;
  rootDir: string;
}): string | null {
  if (!isPathInsideDirectory(options.currentDir, options.rootDir)) return null;
  const candidatePath = getExistingDefaultConfig(options.currentDir);
  if (candidatePath !== null) return candidatePath;
  return continueNearestSearch({
    parent: getParentDirectory(options.currentDir),
    rootDir: options.rootDir,
  });
}

function findNearestDefaultTsconfig(options: {
  rootDir: string;
  startDir: string;
}): string | null {
  return findNearestAt({
    currentDir: normalizeAbsolutePath(options.startDir),
    rootDir: normalizeAbsolutePath(options.rootDir),
  });
}

function resolveConflictingConfigArguments(options: {
  configPath: string;
  cwd: string;
  project: string;
  rootDir: string;
}): string {
  const configPath = resolveProjectConfigPath(options.cwd, options.configPath);
  const projectPath = resolveProjectConfigPath(options.cwd, options.project);
  if (configPath === projectPath) return configPath;
  throw new Error(
    [
      'Conflicting checker build config arguments:',
      `  config: ${toRelativePath(options.rootDir, configPath)}`,
      `  project: ${toRelativePath(options.rootDir, projectPath)}`,
      '  reason: positional checker build config and internal project config must refer to the same path when both are provided.',
    ].join('\n'),
  );
}

function resolveRequestedConfigPath(options: {
  configPath?: string;
  cwd: string;
  project?: string;
  rootDir: string;
}): string | null {
  if (options.configPath !== undefined) {
    return resolveProjectConfigPath(options.cwd, options.configPath);
  }
  if (options.project !== undefined) {
    return resolveProjectConfigPath(options.cwd, options.project);
  }
  return findNearestDefaultTsconfig({
    rootDir: options.rootDir,
    startDir: options.cwd,
  });
}

function requireResolvedConfigPath(options: {
  cwd: string;
  rootDir: string;
  targetConfigPath: string | null;
}): string {
  if (options.targetConfigPath !== null) return options.targetConfigPath;
  throw new Error(
    [
      'Unable to resolve build tsconfig:',
      `  cwd: ${toRelativePath(options.rootDir, options.cwd)}`,
      '  reason: no tsconfig.json was found in this directory or its workspace parents.',
      '  fix: run limina checker build <config>.',
    ].join('\n'),
  );
}

function assertConfigExists(options: {
  rootDir: string;
  targetConfigPath: string;
}): void {
  if (existsSync(options.targetConfigPath)) return;
  throw new Error(
    [
      'Unable to resolve build tsconfig:',
      `  config: ${toRelativePath(options.rootDir, options.targetConfigPath)}`,
      '  reason: the requested source tsconfig does not exist.',
    ].join('\n'),
  );
}

function assertConfigIsFile(options: {
  rootDir: string;
  targetConfigPath: string;
}): void {
  if (!statSync(options.targetConfigPath).isDirectory()) return;
  throw new Error(
    [
      'Unable to resolve build tsconfig:',
      `  config: ${toRelativePath(options.rootDir, options.targetConfigPath)}`,
      '  reason: expected a tsconfig*.json file, but received a directory.',
    ].join('\n'),
  );
}

function assertConfigInsideRoot(options: {
  rootDir: string;
  targetConfigPath: string;
}): void {
  if (isPathInsideDirectory(options.targetConfigPath, options.rootDir)) return;
  throw new Error(
    [
      'Invalid checker build config:',
      `  config: ${options.targetConfigPath}`,
      `  reason: build projects must be inside the Limina workspace root at ${options.rootDir}.`,
    ].join('\n'),
  );
}

function assertJsonConfig(options: {
  rootDir: string;
  targetConfigPath: string;
}): void {
  if (options.targetConfigPath.endsWith('.json')) return;
  throw new Error(
    [
      'Invalid checker build config:',
      `  config: ${toRelativePath(options.rootDir, options.targetConfigPath)}`,
      '  reason: limina checker build expects a JSON config file.',
    ].join('\n'),
  );
}

function assertUserConfig(options: {
  rootDir: string;
  targetConfigPath: string;
}): void {
  if (!options.targetConfigPath.split(path.sep).includes('.limina')) return;
  throw new Error(
    [
      'Invalid checker build config:',
      `  config: ${toRelativePath(options.rootDir, options.targetConfigPath)}`,
      '  reason: .limina generated configs are internal build artifacts, not user build inputs.',
    ].join('\n'),
  );
}

export function resolveBuildConfigPath(options: {
  configPath?: string;
  cwd: string;
  project?: string;
  rootDir: string;
}): string {
  if (options.configPath !== undefined && options.project !== undefined) {
    return resolveConflictingConfigArguments({
      configPath: options.configPath,
      cwd: options.cwd,
      project: options.project,
      rootDir: options.rootDir,
    });
  }
  const targetConfigPath = requireResolvedConfigPath({
    cwd: options.cwd,
    rootDir: options.rootDir,
    targetConfigPath: resolveRequestedConfigPath(options),
  });
  const validation = { rootDir: options.rootDir, targetConfigPath };
  assertConfigExists(validation);
  assertConfigIsFile(validation);
  assertConfigInsideRoot(validation);
  assertJsonConfig(validation);
  assertUserConfig(validation);
  return targetConfigPath;
}

export function formatTypecheckOnlyBuildProblem(options: {
  checkers: readonly ResolvedCheckerConfig[];
  projectRootDir: string;
  sourceConfigPath: string;
}): string {
  return [
    'No build-capable Limina checker found for source tsconfig:',
    `  config: ${toRelativePath(
      options.projectRootDir,
      options.sourceConfigPath,
    )}`,
    '  reason: the matching checker(s) are typecheck-only and cannot run checker build.',
    '  matching checkers:',
    ...options.checkers.map(
      (checker) => `    - config.checkers.${checker.name} (${checker.preset})`,
    ),
    '  fix: configure a build-capable checker such as tsc, tsgo, or vue-tsc for this tsconfig.',
  ].join('\n');
}

export function formatManagedBuildCheckerSelectionProblem(options: {
  availableCheckers: readonly string[];
  commandLabel?: string;
  projectRootDir: string;
  selectedChecker: BuildCheckerPreset;
  sourceConfigPath: string;
}): string {
  const presets =
    options.availableCheckers.length === 0
      ? ['  available presets: none']
      : [
          '  available presets:',
          ...options.availableCheckers.map((checker) => `    - ${checker}`),
        ];
  return [
    `Invalid Limina ${options.commandLabel ?? 'checker build'} preset:`,
    `  config: ${toRelativePath(
      options.projectRootDir,
      options.sourceConfigPath,
    )}`,
    `  preset: ${options.selectedChecker}`,
    '  reason: --preset must select a build-capable checker preset that reaches this Limina-managed target.',
    ...presets,
  ].join('\n');
}

export function formatMultipleOutputBuildPresetProblem(options: {
  availableCheckers: readonly string[];
  projectRootDir: string;
  sourceConfigPath: string;
}): string {
  return [
    'Ambiguous Limina output build preset:',
    `  config: ${toRelativePath(
      options.projectRootDir,
      options.sourceConfigPath,
    )}`,
    '  reason: multiple build-capable checker presets can produce output artifacts for this config.',
    '  fix: pass --preset with one of the available presets.',
    '  available presets:',
    ...options.availableCheckers.map((checker) => `    - ${checker}`),
  ].join('\n');
}
