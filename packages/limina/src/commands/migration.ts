import {
  getActiveCheckers,
  isAutoCheckerConfigMode,
  type ResolvedCheckerConfig,
  type ResolvedLiminaConfig,
} from '#config/runner';
import {
  collectReferencePathInfosForConfig,
  createLiminaTsconfigSchemaPath,
  isOrdinarySourceTypecheckConfigPath,
  type JsonObject,
  readJsonConfig,
} from '#core/tsconfig/actions';
import {
  normalizeAbsolutePath,
  toPosixPath,
  toRelativePath,
} from '#utils/path';
import { formatUnknownValue, isPlainRecord } from '#utils/values';
import { createElapsedTimer } from 'logaria/helper';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { glob } from 'tinyglobby';
import {
  isDefaultSourceTsconfigPath,
  isSolutionStyleTsconfig,
} from '../core/build-graph/generated/config-readers';
import type { LiminaFlowReporter } from '../flow';
import { formatErrorMessage, MigrationLogger } from '../logger';

export interface RunMigrationOptions {
  flow?: LiminaFlowReporter;
  flowDepth?: number;
}

export interface RunMigrationResult {
  checkerEntryCount: number;
  modifiedFiles: string[];
  recursiveReferenceCount: number;
  rootDir: string;
  skippedFiles: string[];
}

interface MigrationEntry {
  configPath: string;
  excludedConfigPaths: Set<string>;
}

interface MigrationEntryCollection {
  activeCheckerCount: number;
  candidateEntryCount: number;
  entries: MigrationEntry[];
  excludePatterns: string[];
  includePatterns: string[];
  mode: 'auto' | 'explicit';
}

interface MigrationTarget {
  configObject: JsonObject;
  configPath: string;
  isSolutionStyle: boolean;
}

interface MigrationTargetCollection {
  checkerEntryCount: number;
  recursiveReferenceCount: number;
  targets: MigrationTarget[];
}

type CompilerOutputField = 'declarationMap' | 'outDir' | 'rootDir' | 'target';

const sourceDiscoveryIgnore = [
  '**/.git/**',
  '**/.limina/**',
  '**/.tsbuild/**',
  '**/coverage/**',
  '**/dist/**',
  '**/node_modules/**',
];
const compilerOutputFields: CompilerOutputField[] = [
  'outDir',
  'rootDir',
  'declarationMap',
  'target',
];
const governedCompilerOptionFields = [
  'composite',
  'declaration',
  'emitDeclarationOnly',
  'incremental',
  'noEmit',
  'tsBuildInfoFile',
];

function normalizeWorkspaceGlob(value: string): string {
  return toPosixPath(value.trim());
}

function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isAutoCheckerMode(config: ResolvedLiminaConfig): boolean {
  return (
    config.config?.checkers === undefined ||
    isAutoCheckerConfigMode(config.config.checkers)
  );
}

function formatConfigPath(config: ResolvedLiminaConfig, configPath: string) {
  return toRelativePath(config.rootDir, configPath);
}

function formatConfigPaths(
  config: ResolvedLiminaConfig,
  configPaths: readonly string[],
): string[] {
  return configPaths.map(
    (configPath) => `  - ${formatConfigPath(config, configPath)}`,
  );
}

function runGitStatus(rootDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      {
        cwd: rootDir,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              [
                'git status --porcelain=v1 --untracked-files=all failed.',
                stderr.trim() ? `stderr: ${stderr.trim()}` : undefined,
                error.message ? `reason: ${error.message}` : undefined,
              ]
                .filter(Boolean)
                .join('\n'),
              { cause: error },
            ),
          );
          return;
        }

        resolve(stdout);
      },
    );
  });
}

async function assertCleanGitWorkspace(rootDir: string): Promise<void> {
  let statusOutput: string;

  try {
    statusOutput = await runGitStatus(rootDir);
  } catch (error) {
    throw new Error(
      [
        'Unable to verify the git working tree before running limina migration.',
        `  root: ${rootDir}`,
        `  reason: ${formatErrorMessage(error)}`,
        '  fix: run limina migration inside a git repository with a clean working tree.',
      ].join('\n'),
      { cause: error },
    );
  }

  const statusLines = statusOutput
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);

  if (statusLines.length === 0) {
    return;
  }

  throw new Error(
    [
      'limina migration requires a clean git working tree before editing tsconfig files.',
      'Commit, stash, or discard these changes, then rerun npx limina migration.',
      'git status:',
      ...statusLines.slice(0, 20).map((line) => `  ${line}`),
      ...(statusLines.length > 20
        ? [`  ... and ${statusLines.length - 20} more`]
        : []),
    ].join('\n'),
  );
}

async function collectExcludedSourceConfigs(
  config: ResolvedLiminaConfig,
  exclude: readonly string[],
): Promise<Set<string>> {
  if (exclude.length === 0) {
    return new Set();
  }

  const paths = await glob(exclude.map(normalizeWorkspaceGlob), {
    absolute: true,
    cwd: config.rootDir,
    ignore: sourceDiscoveryIgnore,
    onlyFiles: true,
  });

  return new Set(paths.map(normalizeAbsolutePath));
}

async function collectExplicitCheckerIncludes(
  config: ResolvedLiminaConfig,
  checker: ResolvedCheckerConfig,
): Promise<string[]> {
  const paths = await glob(checker.include.map(normalizeWorkspaceGlob), {
    absolute: true,
    cwd: config.rootDir,
    ignore: sourceDiscoveryIgnore,
    onlyFiles: true,
  });
  const includedPaths = paths.map(normalizeAbsolutePath).sort();
  const invalidEntryPaths = includedPaths.filter(
    (configPath) => !isDefaultSourceTsconfigPath(configPath),
  );

  if (invalidEntryPaths.length > 0) {
    throw new Error(
      [
        'Checker include matched non-entry tsconfig files:',
        `  checker: ${checker.name}`,
        ...formatConfigPaths(config, invalidEntryPaths),
        '  reason: limina migration only starts from user-side tsconfig.json entry files; non-standard tsconfig.*.json files are migrated only when referenced by a managed solution-style tsconfig.json.',
      ].join('\n'),
    );
  }

  return includedPaths;
}

async function collectAutoMigrationEntries(
  config: ResolvedLiminaConfig,
): Promise<MigrationEntryCollection> {
  const excludePatterns = isAutoCheckerConfigMode(config.config?.checkers)
    ? (config.config.checkers.exclude ?? [])
    : [];
  const excludedConfigPaths = await collectExcludedSourceConfigs(
    config,
    excludePatterns,
  );
  const paths = await glob('**/tsconfig.json', {
    absolute: true,
    cwd: config.rootDir,
    ignore: sourceDiscoveryIgnore,
    onlyFiles: true,
  });
  const candidates = paths
    .map(normalizeAbsolutePath)
    .filter(isDefaultSourceTsconfigPath)
    .sort((left, right) => left.localeCompare(right));
  const entries = candidates
    .filter((configPath) => !excludedConfigPaths.has(configPath))
    .map((configPath) => ({
      configPath,
      excludedConfigPaths,
    }));

  return {
    activeCheckerCount: entries.length > 0 ? 1 : 0,
    candidateEntryCount: candidates.length,
    entries,
    excludePatterns,
    includePatterns: ['**/tsconfig.json'],
    mode: 'auto',
  };
}

async function collectExplicitMigrationEntries(
  config: ResolvedLiminaConfig,
): Promise<MigrationEntryCollection> {
  const checkers = getActiveCheckers(config);
  const entries: MigrationEntry[] = [];
  const includePatterns = new Set<string>();
  const excludePatterns = new Set<string>();
  let candidateEntryCount = 0;

  for (const checker of checkers) {
    for (const include of checker.include) {
      includePatterns.add(include);
    }

    for (const exclude of checker.exclude) {
      excludePatterns.add(exclude);
    }

    const excludedConfigPaths = await collectExcludedSourceConfigs(
      config,
      checker.exclude,
    );
    const includedPaths = await collectExplicitCheckerIncludes(config, checker);

    candidateEntryCount += includedPaths.length;

    for (const configPath of includedPaths) {
      if (excludedConfigPaths.has(configPath)) {
        continue;
      }

      entries.push({
        configPath,
        excludedConfigPaths,
      });
    }
  }

  return {
    activeCheckerCount: checkers.length,
    candidateEntryCount,
    entries,
    excludePatterns: [...excludePatterns].sort(),
    includePatterns: [...includePatterns].sort(),
    mode: 'explicit',
  };
}

async function collectMigrationEntries(
  config: ResolvedLiminaConfig,
): Promise<MigrationEntryCollection> {
  return isAutoCheckerMode(config)
    ? collectAutoMigrationEntries(config)
    : collectExplicitMigrationEntries(config);
}

function formatPatternList(patterns: readonly string[]): string {
  return patterns.length > 0 ? patterns.join(', ') : '(none)';
}

function createNoMigrationEntryError(
  config: ResolvedLiminaConfig,
  collection: MigrationEntryCollection,
): Error {
  const modeReason =
    collection.mode === 'auto'
      ? 'auto mode scans user-side **/tsconfig.json entries, then applies config.checkers.exclude.'
      : 'explicit checker mode expands config.checkers.<name>.include, then applies each checker exclude.';

  return new Error(
    [
      'Limina migration found no tsconfig.json entries to migrate.',
      `  root: ${config.rootDir}`,
      `  mode: ${collection.mode}`,
      `  active checkers: ${collection.activeCheckerCount}`,
      `  include: ${formatPatternList(collection.includePatterns)}`,
      `  exclude: ${formatPatternList(collection.excludePatterns)}`,
      `  candidate entries before exclude: ${collection.candidateEntryCount}`,
      '  active entries after exclude: 0',
      `  reason: ${modeReason}`,
      '  fix: check Limina config.checkers include/exclude, or switch from auto mode to explicit checker includes for the tsconfig.json entries Limina should govern.',
    ].join('\n'),
  );
}

function createExpansionKey(
  configPath: string,
  excludedConfigPaths: Set<string>,
): string {
  return [
    configPath,
    ...[...excludedConfigPaths].sort((left, right) =>
      left.localeCompare(right),
    ),
  ].join('\0');
}

function readMigrationTarget(
  config: ResolvedLiminaConfig,
  configPath: string,
): MigrationTarget {
  const configObject = readJsonConfig(config, configPath);

  return {
    configObject,
    configPath,
    isSolutionStyle: isSolutionStyleTsconfig(configPath, configObject),
  };
}

function collectReferenceTargets(options: {
  config: ResolvedLiminaConfig;
  excludedConfigPaths: Set<string>;
  sourceConfigPath: string;
}): string[] {
  const referenceCollection = collectReferencePathInfosForConfig(
    options.config.rootDir,
    options.sourceConfigPath,
  );

  if (referenceCollection.problems.length > 0) {
    throw new Error(referenceCollection.problems.join('\n\n'));
  }

  return referenceCollection.references
    .map((reference) => reference.resolvedPath)
    .filter((referencePath) => {
      return (
        existsSync(referencePath) &&
        isOrdinarySourceTypecheckConfigPath(referencePath) &&
        !options.excludedConfigPaths.has(referencePath)
      );
    });
}

async function collectMigrationTargets(
  config: ResolvedLiminaConfig,
): Promise<MigrationTargetCollection> {
  const entryCollection = await collectMigrationEntries(config);
  const entries = entryCollection.entries;

  if (entries.length === 0) {
    throw createNoMigrationEntryError(config, entryCollection);
  }

  const entryConfigPaths = new Set(entries.map((entry) => entry.configPath));
  const queued = [...entries];
  const expandedSolutions = new Set<string>();
  const recursiveReferencePaths = new Set<string>();
  const targetsByPath = new Map<string, MigrationTarget>();

  for (const entry of queued) {
    let target = targetsByPath.get(entry.configPath);

    if (!target) {
      target = readMigrationTarget(config, entry.configPath);
      targetsByPath.set(entry.configPath, target);
    }

    if (!target.isSolutionStyle) {
      continue;
    }

    const expansionKey = createExpansionKey(
      entry.configPath,
      entry.excludedConfigPaths,
    );

    if (expandedSolutions.has(expansionKey)) {
      continue;
    }

    expandedSolutions.add(expansionKey);

    for (const referencePath of collectReferenceTargets({
      config,
      excludedConfigPaths: entry.excludedConfigPaths,
      sourceConfigPath: entry.configPath,
    })) {
      if (!entryConfigPaths.has(referencePath)) {
        recursiveReferencePaths.add(referencePath);
      }

      queued.push({
        configPath: referencePath,
        excludedConfigPaths: entry.excludedConfigPaths,
      });
    }
  }

  return {
    checkerEntryCount: entryConfigPaths.size,
    recursiveReferenceCount: recursiveReferencePaths.size,
    targets: [...targetsByPath.values()].sort((left, right) =>
      left.configPath.localeCompare(right.configPath),
    ),
  };
}

function assertPlainObjectField(options: {
  configPath: string;
  field: string;
  rootDir: string;
  value: unknown;
}): Record<string, unknown> {
  if (isPlainRecord(options.value)) {
    return options.value;
  }

  throw new Error(
    [
      'Unable to migrate tsconfig field:',
      `  config: ${toRelativePath(options.rootDir, options.configPath)}`,
      `  field: ${options.field}`,
      `  value: ${formatUnknownValue(options.value)}`,
      '  reason: this field must be an object before Limina can merge migration output into it.',
    ].join('\n'),
  );
}

function mergeOutputOptions(options: {
  configPath: string;
  movedOutputs: Record<string, unknown>;
  rootDir: string;
  tsconfig: JsonObject;
}): void {
  if (Object.keys(options.movedOutputs).length === 0) {
    return;
  }

  const liminaOptionsValue = options.tsconfig.liminaOptions;
  const liminaOptions =
    liminaOptionsValue === undefined
      ? {}
      : {
          ...assertPlainObjectField({
            configPath: options.configPath,
            field: 'liminaOptions',
            rootDir: options.rootDir,
            value: liminaOptionsValue,
          }),
        };
  const outputsValue = liminaOptions.outputs;
  const outputs =
    outputsValue === undefined
      ? {}
      : {
          ...assertPlainObjectField({
            configPath: options.configPath,
            field: 'liminaOptions.outputs',
            rootDir: options.rootDir,
            value: outputsValue,
          }),
        };

  options.tsconfig.liminaOptions = {
    ...liminaOptions,
    outputs: {
      ...outputs,
      ...options.movedOutputs,
    },
  };
}

function migrateTsconfigObject(options: {
  configObject: JsonObject;
  configPath: string;
  isSolutionStyle: boolean;
  rootDir: string;
}): JsonObject {
  const nextConfig: JsonObject = {
    ...options.configObject,
  };
  const movedOutputs: Record<string, unknown> = {};
  const compilerOptionsValue = nextConfig.compilerOptions;

  if (compilerOptionsValue !== undefined) {
    const compilerOptions = {
      ...assertPlainObjectField({
        configPath: options.configPath,
        field: 'compilerOptions',
        rootDir: options.rootDir,
        value: compilerOptionsValue,
      }),
    };

    for (const field of compilerOutputFields) {
      if (!Object.hasOwn(compilerOptions, field)) {
        continue;
      }

      movedOutputs[field] = compilerOptions[field];
      delete compilerOptions[field];
    }

    for (const field of governedCompilerOptionFields) {
      delete compilerOptions[field];
    }

    if (Object.keys(compilerOptions).length === 0) {
      delete nextConfig.compilerOptions;
    } else {
      nextConfig.compilerOptions = compilerOptions;
    }
  }

  if (!options.isSolutionStyle) {
    mergeOutputOptions({
      configPath: options.configPath,
      movedOutputs,
      rootDir: options.rootDir,
      tsconfig: nextConfig,
    });
  }

  if (!options.isSolutionStyle && Object.hasOwn(nextConfig, 'references')) {
    delete nextConfig.references;
  }

  const rest = {
    ...nextConfig,
  };

  delete rest.$schema;

  return {
    $schema: createLiminaTsconfigSchemaPath(
      options.rootDir,
      options.configPath,
    ),
    ...rest,
  };
}

async function writeMigratedTsconfig(options: {
  config: ResolvedLiminaConfig;
  target: MigrationTarget;
}): Promise<'modified' | 'skipped'> {
  const nextConfig = migrateTsconfigObject({
    configObject: options.target.configObject,
    configPath: options.target.configPath,
    isSolutionStyle: options.target.isSolutionStyle,
    rootDir: options.config.rootDir,
  });
  const nextContent = stringifyJson(nextConfig);
  const currentContent = readFileSync(options.target.configPath, 'utf8');

  if (currentContent === nextContent) {
    return 'skipped';
  }

  await writeFile(options.target.configPath, nextContent);
  return 'modified';
}

async function runMigrationImpl(
  config: ResolvedLiminaConfig,
): Promise<RunMigrationResult> {
  await assertCleanGitWorkspace(config.rootDir);

  const targetCollection = await collectMigrationTargets(config);
  const modifiedFiles: string[] = [];
  const skippedFiles: string[] = [];

  for (const target of targetCollection.targets) {
    const status = await writeMigratedTsconfig({
      config,
      target,
    });

    if (status === 'modified') {
      modifiedFiles.push(target.configPath);
    } else {
      skippedFiles.push(target.configPath);
    }
  }

  return {
    checkerEntryCount: targetCollection.checkerEntryCount,
    modifiedFiles,
    recursiveReferenceCount: targetCollection.recursiveReferenceCount,
    rootDir: config.rootDir,
    skippedFiles,
  };
}

function formatMigrationSummary(result: RunMigrationResult): string {
  return [
    `checker entries: ${result.checkerEntryCount}`,
    `recursive references: ${result.recursiveReferenceCount}`,
    `modified files: ${result.modifiedFiles.length}`,
    `skipped files: ${result.skippedFiles.length}`,
  ].join(', ');
}

export async function runMigration(
  config: ResolvedLiminaConfig,
  options: RunMigrationOptions = {},
): Promise<RunMigrationResult> {
  const elapsed = createElapsedTimer();
  const task = options.flow?.start('migrate tsconfig files', {
    collapseOnSuccess: false,
    depth: options.flowDepth ?? 0,
  });

  MigrationLogger.info('migration started');

  try {
    const result = await runMigrationImpl(config);
    const summary = formatMigrationSummary(result);

    MigrationLogger.success(`migration finished: ${summary}`, elapsed());
    task?.pass(summary);

    return result;
  } catch (error) {
    MigrationLogger.error(
      `migration failed: ${formatErrorMessage(error)}`,
      elapsed(),
    );
    task?.fail('migration failed', {
      error,
    });
    throw error;
  }
}
