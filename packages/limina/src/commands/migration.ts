import {
  getActiveCheckers,
  isAutoCheckerConfigMode,
  type ResolvedLiminaConfig,
} from '#config/runner';
import {
  collectReferencePathInfosForConfig,
  createLiminaTsconfigSchemaPath,
  isOrdinarySourceTypecheckConfigPath,
  type JsonObject,
  readJsonConfig,
  validateUserMaintainedLiminaTsconfigMetadata,
} from '#core/tsconfig/actions';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import { formatUnknownValue, isPlainRecord } from '#utils/values';
import { createElapsedTimer } from 'logaria/helper';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import path from 'pathe';
import { isSolutionStyleTsconfig } from '../core/build-graph/generated/config-readers';
import {
  createCheckerEntrySelectionOptions,
  resolveCheckerEntrySelection,
} from '../core/checkers/entry-selection';
import { getWorkspaceRegionBoundaryExclusionReason } from '../core/workspace/regions';
import {
  type ValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../core/workspace/validated-context';
import type { LiminaFlowReporter } from '../flow';
import { formatErrorMessage, MigrationLogger } from '../logger';
import {
  type LiminaPreflightManager,
  type PreflightCapableOptions,
  resolvePreflight,
} from '../preflight';
import {
  executeMigrationWritePlan,
  type MigrationCleanupWarning,
  type MigrationWritePlanItem,
} from './migration-transaction';

export interface RunMigrationOptions extends PreflightCapableOptions {
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
  originalBytes: Buffer;
  originalContent: string;
}

interface MigrationTargetCollection {
  checkerEntryCount: number;
  recursiveReferenceCount: number;
  targets: MigrationTarget[];
}

type CompilerOutputField = 'declarationMap' | 'outDir' | 'rootDir' | 'target';

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

function findGitWorktreeRoot(targetPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const cwd = path.dirname(targetPath);
    execFile(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              [
                `Unable to resolve the Git worktree for ${targetPath}.`,
                stderr.trim() ? `stderr: ${stderr.trim()}` : undefined,
                error.message ? `reason: ${error.message}` : undefined,
                'fix: every migration target must belong to a Git worktree.',
              ]
                .filter(Boolean)
                .join('\n'),
              { cause: error },
            ),
          );
          return;
        }
        resolve(normalizeAbsolutePath(stdout.trim()));
      },
    );
  });
}

async function collectMigrationWorktreeRoots(
  targets: readonly MigrationTarget[],
): Promise<string[]> {
  const rootsByCanonicalIdentity = new Map<string, string>();
  for (const target of targets) {
    const rootDir = await findGitWorktreeRoot(target.configPath);
    const canonicalRootDir = normalizeAbsolutePath(await realpath(rootDir));
    rootsByCanonicalIdentity.set(canonicalRootDir, rootDir);
  }
  return [...rootsByCanonicalIdentity.values()].sort((left, right) =>
    left.localeCompare(right),
  );
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

async function collectAutoMigrationEntries(
  config: ResolvedLiminaConfig,
  sourceConfigPaths: readonly string[],
): Promise<MigrationEntryCollection> {
  const excludePatterns = isAutoCheckerConfigMode(config.config?.checkers)
    ? (config.config.checkers.exclude ?? [])
    : [];
  const selection = await resolveCheckerEntrySelection(
    {
      config,
      sourceConfigPaths,
    },
    {
      checkerName: '__auto__',
      exclude: excludePatterns,
      include: ['**/tsconfig.json'],
    },
  );
  const entries = selection.effectiveEntryPaths.map((configPath) => ({
    configPath,
  }));

  return {
    activeCheckerCount: entries.length > 0 ? 1 : 0,
    candidateEntryCount: selection.includedEntryPaths.length,
    entries,
    excludePatterns,
    includePatterns: ['**/tsconfig.json'],
    mode: 'auto',
  };
}

async function collectExplicitMigrationEntries(
  config: ResolvedLiminaConfig,
  sourceConfigPaths: readonly string[],
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

    const selection = await resolveCheckerEntrySelection(
      {
        config,
        sourceConfigPaths,
      },
      createCheckerEntrySelectionOptions(checker),
    );

    candidateEntryCount += selection.includedEntryPaths.length;

    for (const configPath of selection.effectiveEntryPaths) {
      entries.push({ configPath });
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
  sourceConfigPaths: readonly string[],
): Promise<MigrationEntryCollection> {
  return isAutoCheckerMode(config)
    ? collectAutoMigrationEntries(config, sourceConfigPaths)
    : collectExplicitMigrationEntries(config, sourceConfigPaths);
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
      ? 'auto mode scans user-side **/tsconfig.json entries inside activated regions, then applies config.checkers.exclude.'
      : 'explicit checker mode expands config.checkers.<name>.include inside activated regions, then applies each checker exclude.';

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

async function readMigrationTarget(
  config: ResolvedLiminaConfig,
  configPath: string,
  planningVirtualFiles: Map<string, string>,
): Promise<MigrationTarget> {
  const normalizedConfigPath = normalizeAbsolutePath(configPath);
  let originalContent = planningVirtualFiles.get(normalizedConfigPath);
  let originalBytes: Buffer;

  if (originalContent === undefined) {
    originalBytes = await readFile(normalizedConfigPath);
    originalContent = originalBytes.toString('utf8');
    planningVirtualFiles.set(normalizedConfigPath, originalContent);
  } else {
    originalBytes = Buffer.from(originalContent);
  }

  const configObject = readJsonConfig(
    config,
    normalizedConfigPath,
    planningVirtualFiles,
  );

  return {
    configObject,
    configPath: normalizedConfigPath,
    isSolutionStyle: isSolutionStyleTsconfig(
      normalizedConfigPath,
      configObject,
    ),
    originalBytes,
    originalContent,
  };
}

function collectReferenceTargets(options: {
  config: ResolvedLiminaConfig;
  pathIndex: WorkspaceRegionPathIndex;
  planningVirtualFiles: ReadonlyMap<string, string>;
  sourceConfigPath: string;
}): string[] {
  const referenceCollection = collectReferencePathInfosForConfig(
    options.config.rootDir,
    options.sourceConfigPath,
    options.planningVirtualFiles,
  );

  if (referenceCollection.problems.length > 0) {
    throw new Error(referenceCollection.problems.join('\n\n'));
  }

  const referencePaths: string[] = [];

  for (const reference of referenceCollection.references) {
    const referencePath = reference.resolvedPath;

    if (!existsSync(referencePath)) {
      continue;
    }

    if (!isOrdinarySourceTypecheckConfigPath(referencePath)) {
      continue;
    }

    if (!options.pathIndex.isSourceConfigPath(referencePath)) {
      const boundary = options.pathIndex.findBoundaryForPath(referencePath);
      const reason = boundary
        ? getWorkspaceRegionBoundaryExclusionReason(boundary)
        : null;

      throw new Error(
        [
          'Referenced checker source config is outside activated workspace package regions:',
          `  from config: ${formatConfigPath(options.config, options.sourceConfigPath)}`,
          `  referenced config: ${formatConfigPath(options.config, referencePath)}`,
          ...(boundary
            ? [
                `  boundary kind: ${boundary.kind}`,
                `  boundary root: ${formatConfigPath(options.config, boundary.rootDir)}`,
                ...(reason ? [`  boundary exclusion reason: ${reason}`] : []),
                '  reason: the referenced config is outside the current activated workspace package region.',
              ]
            : [
                '  reason: the referenced config is not owned by any current-run activated workspace package.',
              ]),
        ].join('\n'),
      );
    }

    referencePaths.push(referencePath);
  }

  return referencePaths;
}

async function collectMigrationTargets(
  config: ResolvedLiminaConfig,
  context: ValidatedWorkspaceContext,
): Promise<MigrationTargetCollection> {
  const pathIndex = new WorkspaceRegionPathIndex(context);
  const entryCollection = await collectMigrationEntries(
    config,
    context.sourceConfigPaths,
  );
  const entries = entryCollection.entries;

  if (entries.length === 0) {
    throw createNoMigrationEntryError(config, entryCollection);
  }

  const entryConfigPaths = new Set(entries.map((entry) => entry.configPath));
  const queued = [...entries];
  const expandedSolutions = new Set<string>();
  const queuedConfigPaths = new Set(entries.map((entry) => entry.configPath));
  const recursiveReferencePaths = new Set<string>();
  const targetsByPath = new Map<string, MigrationTarget>();
  const planningVirtualFiles = new Map<string, string>();

  for (const entry of queued) {
    let target = targetsByPath.get(entry.configPath);

    if (!target) {
      target = await readMigrationTarget(
        config,
        entry.configPath,
        planningVirtualFiles,
      );
      targetsByPath.set(entry.configPath, target);
    }

    if (!target.isSolutionStyle) {
      continue;
    }

    if (expandedSolutions.has(entry.configPath)) {
      continue;
    }

    expandedSolutions.add(entry.configPath);

    for (const referencePath of collectReferenceTargets({
      config,
      pathIndex,
      planningVirtualFiles,
      sourceConfigPath: entry.configPath,
    })) {
      if (!entryConfigPaths.has(referencePath)) {
        recursiveReferencePaths.add(referencePath);
      }

      if (!queuedConfigPaths.has(referencePath)) {
        queuedConfigPaths.add(referencePath);
        queued.push({ configPath: referencePath });
      }
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

function createMigrationWritePlanItem(options: {
  config: ResolvedLiminaConfig;
  target: MigrationTarget;
}): MigrationWritePlanItem {
  const nextConfig = migrateTsconfigObject({
    configObject: options.target.configObject,
    configPath: options.target.configPath,
    isSolutionStyle: options.target.isSolutionStyle,
    rootDir: options.config.rootDir,
  });
  const nextContent = stringifyJson(nextConfig);

  return {
    configPath: options.target.configPath,
    nextContent,
    originalBytes: options.target.originalBytes,
    originalContent: options.target.originalContent,
    status:
      options.target.originalContent === nextContent ? 'skipped' : 'modified',
  };
}

interface RunMigrationImplResult {
  cleanupWarnings: MigrationCleanupWarning[];
  result: RunMigrationResult;
}

async function runMigrationImpl(
  config: ResolvedLiminaConfig,
  preflight: LiminaPreflightManager,
): Promise<RunMigrationImplResult> {
  const context = await preflight.ensureWorkspaceValidated();
  const targetCollection = await collectMigrationTargets(config, context);

  for (const target of targetCollection.targets) {
    validateUserMaintainedLiminaTsconfigMetadata({
      configObject: target.configObject,
      configPath: target.configPath,
    });
  }

  const worktreeRoots = await collectMigrationWorktreeRoots(
    targetCollection.targets,
  );
  await Promise.all(worktreeRoots.map(assertCleanGitWorkspace));
  const writePlan = targetCollection.targets.map((target) =>
    createMigrationWritePlanItem({
      config,
      target,
    }),
  );
  const execution = await executeMigrationWritePlan(worktreeRoots, writePlan);

  return {
    cleanupWarnings: execution.cleanupWarnings,
    result: {
      checkerEntryCount: targetCollection.checkerEntryCount,
      modifiedFiles: execution.modifiedFiles,
      recursiveReferenceCount: targetCollection.recursiveReferenceCount,
      rootDir: config.rootDir,
      skippedFiles: execution.skippedFiles,
    },
  };
}

function formatMigrationSummary(
  result: RunMigrationResult,
  cleanupWarningCount = 0,
): string {
  return [
    `checker entries: ${result.checkerEntryCount}`,
    `recursive references: ${result.recursiveReferenceCount}`,
    `modified files: ${result.modifiedFiles.length}`,
    `skipped files: ${result.skippedFiles.length}`,
    ...(cleanupWarningCount > 0
      ? [`cleanup warnings: ${cleanupWarningCount}`]
      : []),
  ].join(', ');
}

export async function runMigration(
  config: ResolvedLiminaConfig,
  options: RunMigrationOptions = {},
): Promise<RunMigrationResult> {
  const preflight = resolvePreflight(config, options);
  const elapsed = createElapsedTimer();
  const task = options.flow?.start('migrate tsconfig files', {
    collapseOnSuccess: false,
    depth: options.flowDepth ?? 0,
  });

  MigrationLogger.info('migration started');

  try {
    const execution = await runMigrationImpl(config, preflight);
    const result = execution.result;

    for (const warning of execution.cleanupWarnings) {
      const message = `${warning.message}\n  recovery path: ${warning.path}`;
      MigrationLogger.warn(message);
      options.flow?.warn(message, {
        depth: options.flowDepth ?? 0,
      });
    }

    const summary = formatMigrationSummary(
      result,
      execution.cleanupWarnings.length,
    );

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
