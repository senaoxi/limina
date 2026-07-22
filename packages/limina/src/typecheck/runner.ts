import {
  type CheckerPackageResolver,
  getCheckerAdapter,
  getCheckerExtensions,
} from '#checkers';
import {
  type BuildCheckerPreset,
  getActiveCheckers,
  type ResolvedCheckerConfig,
  type ResolvedLiminaConfig,
} from '#config/runner';
import type { AnalysisProviderSet } from '#core';
import type {
  GeneratedBuildModule,
  GeneratedOutputDeclarationCopyContext,
  GeneratedTsconfigGraphResult,
} from '#core/build-graph/runner';
import {
  collectGraphProjectRouteFromRoot,
  getRawReferencePathsForConfig,
  isDtsConfigPath,
  isOrdinarySourceTypecheckConfigPath,
  resolveProjectConfigPath,
} from '#core/tsconfig/actions';
import { uniqueSortedStrings } from '#utils/collections';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  toRelativePath,
} from '#utils/path';
import { existsSync, statSync } from 'node:fs';
import path from 'pathe';
import type { CheckIssueReportOptions } from '../check-reporting/human';
import type { ValidatedWorkspaceContext } from '../core/workspace/validated-context';
import { resolveCheckerTypecheckConcurrency } from '../execution/config';
import { runPool } from '../execution/pool';
import type {
  TaskProgressItem,
  TaskProgressReporter,
} from '../execution/progress';
import type { LiminaFlowReporter, LiminaFlowTask } from '../flow';
import { formatErrorMessage, TypecheckLogger } from '../logger';
import { type LiminaPreflightManager, resolvePreflight } from '../preflight';
import { formatCheckIssueSummaryReport } from '../reporting';
import { runBuildTargets } from './build-plan';
import { ManagedCheckerMutationCoordinator } from './managed-mutation';
import {
  copyOutputDeclarationInputs,
  createOutputDeclarationCopyPlan,
  formatOutputDeclarationCopyErrors,
  formatOutputDeclarationCopyWarnings,
  mergeOutputDeclarationCopyPlans,
  OutputDeclarationCopyError,
} from './output-declarations';
import {
  type CheckerTargetId,
  type CheckerTargetOutcome,
  collectCheckerPeerDependencyProblems,
  createCheckerTarget,
  createDefaultRunner,
  getExecutionCheckers,
  runTargetWithMeasuredDuration,
  toCheckerTargetOutcome,
  type TypecheckRunner,
  type TypecheckTarget,
  type TypecheckTargetResult,
} from './targets';
import { VueTsgoCacheBatchCoordinator } from './vue-tsgo-cache';

export interface RunCheckerBuildOptions {
  clearScreen?: boolean;
  checker?: BuildCheckerPreset;
  configPath?: string;
  config: ResolvedLiminaConfig;
  providers?: AnalysisProviderSet;
  cwd?: string;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
  preflight?: LiminaPreflightManager;
  progress?: TaskProgressReporter;
  report?: CheckIssueReportOptions;
  checkerPackageResolver?: CheckerPackageResolver;
  runner?: TypecheckRunner;
  tscCommand?: string;
  watch?: boolean;
}

export interface CheckerFailureTarget {
  blockedByTarget?: readonly CheckerTargetId[];
  checkerName?: string;
  configPath: string;
  exitCode: number;
  id?: CheckerTargetId;
  message?: string;
}

export type CheckerFailureKind =
  | 'peer-dependency'
  | 'process'
  | 'target-selection';

export interface RunCheckerBuildResult {
  failedTargets: CheckerFailureTarget[];
  failureKind?: CheckerFailureKind;
  passed: boolean;
  problems?: string[];
  projectRootDir: string;
  rootConfigPaths: string[];
  targetResults: TypecheckTargetResult[];
  targetOutcomes?: CheckerTargetOutcome[];
}

export interface RunBuildOptions {
  clearScreen?: boolean;
  checker?: BuildCheckerPreset;
  configPath?: string;
  config: ResolvedLiminaConfig;
  providers?: AnalysisProviderSet;
  cwd?: string;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
  preflight?: LiminaPreflightManager;
  report?: CheckIssueReportOptions;
  checkerPackageResolver?: CheckerPackageResolver;
  project?: string;
  raw?: boolean;
  runner?: TypecheckRunner;
  tscCommand?: string;
  watch?: boolean;
}

export interface RunBuildResult {
  failedTargets: CheckerFailureTarget[];
  failureKind?: CheckerFailureKind;
  passed: boolean;
  problems?: string[];
  projectRootDir: string;
  rootConfigPaths: string[];
  sourceConfigPath: string | null;
}

export interface RunCheckerTypecheckOptions {
  clearScreen?: boolean;
  config: ResolvedLiminaConfig;
  providers?: AnalysisProviderSet;
  cwd?: string;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
  preflight?: LiminaPreflightManager;
  progress?: TaskProgressReporter;
  report?: CheckIssueReportOptions;
  checkerPackageResolver?: CheckerPackageResolver;
  runner?: TypecheckRunner;
  tscCommand?: string;
}

export interface RunCheckerTypecheckResult {
  failedTargets: CheckerFailureTarget[];
  failureKind?: CheckerFailureKind;
  passed: boolean;
  problems?: string[];
  projectRootDir: string;
  rootConfigPaths: string[];
  targetResults: TypecheckTargetResult[];
}

type CheckerFlowTask = LiminaFlowTask | TaskProgressItem;

function getCheckerTargetFlowLabel(
  target: TypecheckTarget,
  prefix: string,
  projectRootDir: string,
): string {
  return (
    target.label ??
    `${prefix}: ${toRelativePath(projectRootDir, target.configPath)}`
  );
}

function createPlannedCheckerTargetTasks(
  targets: readonly TypecheckTarget[],
  progress: TaskProgressReporter | undefined,
  prefix: string,
  projectRootDir: string,
): Map<CheckerTargetId, TaskProgressItem> {
  const tasks = new Map<CheckerTargetId, TaskProgressItem>();

  if (!progress) {
    return tasks;
  }

  for (const target of targets) {
    tasks.set(
      target.id,
      progress.planItem(
        getCheckerTargetFlowLabel(target, prefix, projectRootDir),
      ),
    );
  }

  return tasks;
}

function formatTypecheckProblemSummaryReport(options: {
  pluralIssueLabel: string;
  problems: readonly string[];
  singularIssueLabel: string;
  title: string;
}): string {
  return formatCheckIssueSummaryReport({
    details: options.problems.join('\n\n'),
    issueCount: options.problems.length,
    pluralIssueLabel: options.pluralIssueLabel,
    singularIssueLabel: options.singularIssueLabel,
    title: options.title,
  });
}

function shouldLogCheckReport(
  report: CheckIssueReportOptions | undefined,
): boolean {
  return !report?.defer;
}

function resolveTypecheckRunner(options: {
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  report?: CheckIssueReportOptions;
  runner?: TypecheckRunner;
}): TypecheckRunner {
  return (
    options.runner ??
    createDefaultRunner({
      onDegraded: (reason) => {
        const message = `checker duration measurement degraded: ${reason}`;

        if (options.flow) {
          options.flow.warn(message, {
            depth: (options.flowDepth ?? 0) + 1,
            persistInteractive: true,
          });
          return;
        }

        TypecheckLogger.warn(message);
      },
      stdio: options.report?.defer ? 'ignore' : 'inherit',
    })
  );
}

function completeCheckerTargetTask(
  task: CheckerFlowTask,
  result: TypecheckTargetResult,
): void {
  const elapsedOptions =
    result.durationMs === undefined
      ? undefined
      : { elapsedTimeMs: result.durationMs };

  if (result.blockedBy) {
    task.skip(`blocked by ${result.blockedBy.join(', ')}`, elapsedOptions);
    return;
  }

  if (result.status === 0) {
    task.pass(undefined, elapsedOptions);
    return;
  }

  const suffix = result.error
    ? formatErrorMessage(result.error)
    : `exited with code ${result.status}`;

  task.fail(undefined, { ...elapsedOptions, error: suffix });
}

function formatFailedTargetSummaryReport(options: {
  failedResults: readonly TypecheckTargetResult[];
  heading: string;
  pluralIssueLabel: string;
  projectRootDir: string;
  singularIssueLabel: string;
  title: string;
}): string {
  return formatCheckIssueSummaryReport({
    details: [
      options.heading,
      ...options.failedResults.map((result) => {
        if (result.blockedBy) {
          return `  ${toRelativePath(options.projectRootDir, result.configPath)} blocked by ${result.blockedBy.join(', ')}`;
        }
        const suffix = result.error
          ? `: ${formatErrorMessage(result.error)}`
          : ` exited with code ${result.status}`;

        return `  ${toRelativePath(options.projectRootDir, result.configPath)}${suffix}`;
      }),
    ].join('\n'),
    issueCount: options.failedResults.length,
    pluralIssueLabel: options.pluralIssueLabel,
    singularIssueLabel: options.singularIssueLabel,
    title: options.title,
  });
}

function collectFailedCheckerTargets(
  targets: readonly TypecheckTarget[],
  results: readonly TypecheckTargetResult[],
): CheckerFailureTarget[] {
  const targetsById = new Map(targets.map((target) => [target.id, target]));

  return results
    .filter((result) => result.status !== 0)
    .map((result) => {
      const target = targetsById.get(result.id);

      return {
        blockedByTarget: result.blockedBy,
        checkerName: target?.checkerName,
        configPath: result.configPath,
        exitCode: result.status,
        id: result.id,
        message: result.error ? formatErrorMessage(result.error) : undefined,
      };
    });
}

export async function runCheckerBuildImpl(
  options: RunCheckerBuildOptions,
): Promise<RunCheckerBuildResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const projectRootDir = normalizeAbsolutePath(options.config.rootDir);
  const preflight = resolvePreflight(options.config, options);
  const workspaceContext = await preflight.ensureWorkspaceValidated();
  const generatedGraph = (
    await preflight.ensureGeneratedArtifactsMaterialized()
  ).graph;
  const allCheckers = generatedGraph.checkers;
  const checkers = getExecutionCheckers({
    checkers: allCheckers,
    executionKind: 'build',
  });
  const flowDepth = options.flowDepth ?? 0;
  const rootConfigPaths: string[] = [];

  if (options.configPath) {
    const sourceConfigPath = resolveBuildConfigPath({
      configPath: options.configPath,
      cwd,
      rootDir: projectRootDir,
    });
    const managedTargets = collectManagedDeclarationBuildTargets({
      allCheckers,
      generatedGraph,
      sourceConfigPath,
    });
    const buildCapableTargets = managedTargets.filter(
      ({ checker }) => getCheckerAdapter(checker.preset)?.execution === 'build',
    );
    const availableCheckers = uniqueSortedStrings(
      buildCapableTargets.map(({ checker }) => checker.preset),
    );
    const checkerTargets = options.checker
      ? buildCapableTargets.filter(
          ({ checker }) => checker.preset === options.checker,
        )
      : buildCapableTargets;

    if (checkerTargets.length === 0) {
      const selectionProblem = options.checker
        ? formatManagedBuildCheckerSelectionProblem({
            availableCheckers,
            projectRootDir,
            selectedChecker: options.checker,
            sourceConfigPath,
          })
        : managedTargets.length > 0
          ? formatTypecheckOnlyBuildProblem({
              checkers: managedTargets.map(({ checker }) => checker),
              projectRootDir,
              sourceConfigPath,
            })
          : [
              'Unmanaged Limina checker build config:',
              `  config: ${toRelativePath(projectRootDir, sourceConfigPath)}`,
              '  reason: limina checker build <config> only accepts source configs managed by Limina checker.include.',
              '  fix: add the owning tsconfig.json entry to checker.include, or use limina build <config> --raw --preset <checker> for a direct raw build.',
            ].join('\n');

      if (shouldLogCheckReport(options.report)) {
        TypecheckLogger.error(
          formatTypecheckProblemSummaryReport({
            pluralIssueLabel: 'checker build selection issues',
            problems: [selectionProblem],
            singularIssueLabel: 'checker build selection issue',
            title: 'Checker build summary',
          }),
        );
      }

      return {
        failedTargets: [],
        failureKind: 'target-selection',
        passed: false,
        problems: [selectionProblem],
        projectRootDir,
        rootConfigPaths,
        targetResults: [],
      };
    }

    const problems = collectCheckerPeerDependencyProblems({
      checkers: checkerTargets.map(({ checker }) => checker),
      imports: options.config.config?.imports,
      projectRootDir,
      resolvePackage: options.checkerPackageResolver,
    });

    if (problems.length > 0) {
      if (shouldLogCheckReport(options.report)) {
        TypecheckLogger.error(
          formatTypecheckProblemSummaryReport({
            pluralIssueLabel: 'checker build issues',
            problems,
            singularIssueLabel: 'checker build issue',
            title: 'Checker build summary',
          }),
        );
      }

      return {
        failedTargets: [],
        failureKind: 'peer-dependency',
        passed: false,
        problems,
        projectRootDir,
        rootConfigPaths,
        targetResults: [],
      };
    }

    const targets = checkerTargets.map(
      ({ buildModule, checker, sourceConfigPath }) => {
        rootConfigPaths.push(buildModule.path);

        return {
          ...createCheckerTarget({
            checker,
            commandOverride: options.tscCommand,
            configPath: buildModule.path,
            executionKind: 'build',
            projectRootDir,
            sourceConfigPath,
            watch: options.watch,
          }),
          sourceConfigPath,
        };
      },
    );

    options.flow?.info(`found ${targets.length} checker build target(s)`, {
      depth: flowDepth + 1,
    });

    const targetTasks: Map<CheckerTargetId, CheckerFlowTask> = new Map(
      createPlannedCheckerTargetTasks(
        targets,
        options.progress,
        'checker build',
        projectRootDir,
      ),
    );
    const mutationCoordinator = await ManagedCheckerMutationCoordinator.create({
      artifactNamespace: preflight.artifactNamespace,
      checkers: allCheckers,
      config: options.config,
      generatedGraph,
      targets,
      workspaceContext,
    });
    const results = await runBuildTargets(
      targets,
      generatedGraph.providerEdges,
      resolveTypecheckRunner(options),
      {
        beforeLayerRun: (targets) =>
          mutationCoordinator.beforeLayerRun(targets),
        beforeTargetRun: (target) =>
          mutationCoordinator.beforeTargetRun(target),
        config: options.config,
        onTargetResult: (target, result) => {
          const task = targetTasks.get(target.id);

          if (!task) {
            return;
          }

          completeCheckerTargetTask(task, result);
        },
        onTargetStart: (target) => {
          if (options.progress) {
            (
              targetTasks.get(target.id) as TaskProgressItem | undefined
            )?.start();
            return;
          }

          if (!options.flow) {
            return;
          }

          targetTasks.set(
            target.id,
            options.flow.start(
              getCheckerTargetFlowLabel(
                target,
                'checker build',
                projectRootDir,
              ),
              {
                collapseOnSuccess: false,
                depth: flowDepth + 1,
              },
            ),
          );
        },
        watch: options.watch,
      },
    );
    const failedResults = results.filter((result) => result.status !== 0);
    const failedTargets = collectFailedCheckerTargets(targets, failedResults);
    const passed = failedResults.length === 0;

    if (!passed && shouldLogCheckReport(options.report)) {
      TypecheckLogger.error(
        formatFailedTargetSummaryReport({
          failedResults,
          heading: 'build checks failed:',
          pluralIssueLabel: 'failed checker build targets',
          projectRootDir,
          singularIssueLabel: 'failed checker build target',
          title: 'Checker build summary',
        }),
      );
    } else if (
      passed &&
      shouldLogCheckReport(options.report) &&
      !options.flow?.interactive
    ) {
      TypecheckLogger.success(
        `Checked ${targets.length} checker build target(s).`,
      );
    }

    return {
      failedTargets,
      passed,
      projectRootDir,
      rootConfigPaths,
      targetResults: results,
      targetOutcomes: results.map((result) =>
        toCheckerTargetOutcome(
          targets.find((target) => target.id === result.id)!,
          result,
        ),
      ),
    };
  }

  const problems = collectCheckerPeerDependencyProblems({
    checkers: allCheckers,
    imports: options.config.config?.imports,
    projectRootDir,
    resolvePackage: options.checkerPackageResolver,
  });

  if (problems.length > 0) {
    const preflightItem = options.progress?.startItem(
      'checker dependency preflight',
    );

    preflightItem?.fail();
    if (!options.progress) {
      options.flow?.fail('checker dependency preflight failed', {
        depth: flowDepth + 1,
      });
    }
    if (shouldLogCheckReport(options.report)) {
      TypecheckLogger.error(
        formatTypecheckProblemSummaryReport({
          pluralIssueLabel: 'checker build issues',
          problems,
          singularIssueLabel: 'checker build issue',
          title: 'Checker build summary',
        }),
      );
    }

    return {
      failedTargets: [],
      failureKind: 'peer-dependency',
      passed: false,
      problems,
      projectRootDir,
      rootConfigPaths,
      targetResults: [],
    };
  }

  const targets = checkers.flatMap((checker) => {
    const configPath = generatedGraph.checkerEntries.get(checker.name);

    if (!configPath) {
      throw new Error(`Missing generated entry for checker "${checker.name}".`);
    }

    rootConfigPaths.push(configPath);

    return [
      createCheckerTarget({
        checker,
        commandOverride: options.tscCommand,
        configPath,
        executionKind: 'build',
        projectRootDir,
      }),
    ];
  });

  options.flow?.info(`found ${targets.length} checker build entry(s)`, {
    depth: flowDepth + 1,
  });

  if (shouldLogCheckReport(options.report)) {
    TypecheckLogger.info(
      [
        `Running build checks for ${targets.length} checker entry(s).`,
        `CWD: ${toRelativePath(cwd, projectRootDir)}`,
        `Entries: ${rootConfigPaths
          .map((configPath) => toRelativePath(projectRootDir, configPath))
          .join(', ')}`,
      ].join('\n'),
    );
  }

  const targetTasks: Map<CheckerTargetId, CheckerFlowTask> = new Map(
    createPlannedCheckerTargetTasks(
      targets,
      options.progress,
      'checker build',
      projectRootDir,
    ),
  );
  const mutationCoordinator = await ManagedCheckerMutationCoordinator.create({
    artifactNamespace: preflight.artifactNamespace,
    checkers: allCheckers,
    config: options.config,
    generatedGraph,
    targets,
    workspaceContext,
  });
  const results = await runBuildTargets(
    targets,
    generatedGraph.providerEdges,
    resolveTypecheckRunner(options),
    {
      beforeLayerRun: (targets) => mutationCoordinator.beforeLayerRun(targets),
      beforeTargetRun: (target) => mutationCoordinator.beforeTargetRun(target),
      config: options.config,
      onTargetResult: (target, result) => {
        const task = targetTasks.get(target.id);

        if (!task) {
          return;
        }

        completeCheckerTargetTask(task, result);
      },
      onTargetStart: (target) => {
        if (options.progress) {
          (targetTasks.get(target.id) as TaskProgressItem | undefined)?.start();
          return;
        }

        if (!options.flow) {
          return;
        }

        targetTasks.set(
          target.id,
          options.flow.start(
            getCheckerTargetFlowLabel(target, 'checker build', projectRootDir),
            {
              collapseOnSuccess: false,
              depth: flowDepth + 1,
            },
          ),
        );
      },
    },
  );
  const failedResults = results.filter((result) => result.status !== 0);
  const failedTargets = collectFailedCheckerTargets(targets, failedResults);
  const passed = failedResults.length === 0;

  reportBuildCheckerCombinationWarning({
    entries: collectBuildGraphCombinationEntries({
      generatedGraph,
      projectRootDir,
      roots: collectCheckerBuildCombinationRoots({
        checkers,
        generatedGraph,
        projectRootDir,
      }),
    }),
    flow: options.flow,
    flowDepth,
    projectRootDir,
    report: options.report,
  });

  if (!passed) {
    if (shouldLogCheckReport(options.report)) {
      TypecheckLogger.error(
        formatFailedTargetSummaryReport({
          failedResults,
          heading: 'build checks failed:',
          pluralIssueLabel: 'failed checker build targets',
          projectRootDir,
          singularIssueLabel: 'failed checker build target',
          title: 'Checker build summary',
        }),
      );
    }
  } else if (
    shouldLogCheckReport(options.report) &&
    !options.flow?.interactive
  ) {
    TypecheckLogger.success(
      `Checked ${targets.length} checker build entry(s).`,
    );
  }

  return {
    failedTargets,
    passed,
    projectRootDir,
    rootConfigPaths,
    targetResults: results,
    targetOutcomes: results.map((result) =>
      toCheckerTargetOutcome(
        targets.find((target) => target.id === result.id)!,
        result,
      ),
    ),
  };
}

function findNearestDefaultTsconfig(options: {
  rootDir: string;
  startDir: string;
}): string | null {
  let currentDir = normalizeAbsolutePath(options.startDir);
  const rootDir = normalizeAbsolutePath(options.rootDir);

  while (isPathInsideDirectory(currentDir, rootDir)) {
    const candidatePath = path.join(currentDir, 'tsconfig.json');

    if (existsSync(candidatePath)) {
      return normalizeAbsolutePath(candidatePath);
    }

    if (currentDir === rootDir) {
      return null;
    }

    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }

  return null;
}

function resolveBuildConfigPath(options: {
  configPath?: string;
  cwd: string;
  project?: string;
  rootDir: string;
}): string {
  if (options.configPath && options.project) {
    const configPath = resolveProjectConfigPath(
      options.cwd,
      options.configPath,
    );
    const projectPath = resolveProjectConfigPath(options.cwd, options.project);

    if (configPath !== projectPath) {
      throw new Error(
        [
          'Conflicting checker build config arguments:',
          `  config: ${toRelativePath(options.rootDir, configPath)}`,
          `  project: ${toRelativePath(options.rootDir, projectPath)}`,
          '  reason: positional checker build config and internal project config must refer to the same path when both are provided.',
        ].join('\n'),
      );
    }

    return configPath;
  }

  const targetConfigPath = options.configPath
    ? resolveProjectConfigPath(options.cwd, options.configPath)
    : options.project
      ? resolveProjectConfigPath(options.cwd, options.project)
      : findNearestDefaultTsconfig({
          rootDir: options.rootDir,
          startDir: options.cwd,
        });

  if (!targetConfigPath) {
    throw new Error(
      [
        'Unable to resolve build tsconfig:',
        `  cwd: ${toRelativePath(options.rootDir, options.cwd)}`,
        '  reason: no tsconfig.json was found in this directory or its workspace parents.',
        '  fix: run limina checker build <config>.',
      ].join('\n'),
    );
  }

  if (!existsSync(targetConfigPath)) {
    throw new Error(
      [
        'Unable to resolve build tsconfig:',
        `  config: ${toRelativePath(options.rootDir, targetConfigPath)}`,
        '  reason: the requested source tsconfig does not exist.',
      ].join('\n'),
    );
  }

  if (statSync(targetConfigPath).isDirectory()) {
    throw new Error(
      [
        'Unable to resolve build tsconfig:',
        `  config: ${toRelativePath(options.rootDir, targetConfigPath)}`,
        '  reason: expected a tsconfig*.json file, but received a directory.',
      ].join('\n'),
    );
  }

  if (!isPathInsideDirectory(targetConfigPath, options.rootDir)) {
    throw new Error(
      [
        'Invalid checker build config:',
        `  config: ${targetConfigPath}`,
        `  reason: build projects must be inside the Limina workspace root at ${options.rootDir}.`,
      ].join('\n'),
    );
  }

  if (!targetConfigPath.endsWith('.json')) {
    throw new Error(
      [
        'Invalid checker build config:',
        `  config: ${toRelativePath(options.rootDir, targetConfigPath)}`,
        '  reason: limina checker build expects a JSON config file.',
      ].join('\n'),
    );
  }

  if (targetConfigPath.split(path.sep).includes('.limina')) {
    throw new Error(
      [
        'Invalid checker build config:',
        `  config: ${toRelativePath(options.rootDir, targetConfigPath)}`,
        '  reason: .limina generated configs are internal build artifacts, not user build inputs.',
      ].join('\n'),
    );
  }

  return targetConfigPath;
}

function formatTypecheckOnlyBuildProblem(options: {
  checkers: ResolvedCheckerConfig[];
  projectRootDir: string;
  sourceConfigPath: string;
}): string {
  return [
    'No build-capable Limina checker found for source tsconfig:',
    `  config: ${toRelativePath(options.projectRootDir, options.sourceConfigPath)}`,
    '  reason: the matching checker(s) are typecheck-only and cannot run checker build.',
    '  matching checkers:',
    ...options.checkers.map(
      (checker) => `    - config.checkers.${checker.name} (${checker.preset})`,
    ),
    '  fix: configure a build-capable checker such as tsc, tsgo, or vue-tsc for this tsconfig.',
  ].join('\n');
}

function formatManagedBuildCheckerSelectionProblem(options: {
  availableCheckers: string[];
  commandLabel?: string;
  projectRootDir: string;
  selectedChecker: BuildCheckerPreset;
  sourceConfigPath: string;
}): string {
  return [
    `Invalid Limina ${options.commandLabel ?? 'checker build'} preset:`,
    `  config: ${toRelativePath(options.projectRootDir, options.sourceConfigPath)}`,
    `  preset: ${options.selectedChecker}`,
    '  reason: --preset must select a build-capable checker preset that reaches this Limina-managed target.',
    ...(options.availableCheckers.length > 0
      ? [
          '  available presets:',
          ...options.availableCheckers.map((checker) => `    - ${checker}`),
        ]
      : ['  available presets: none']),
  ].join('\n');
}

function formatMultipleOutputBuildPresetProblem(options: {
  availableCheckers: string[];
  projectRootDir: string;
  sourceConfigPath: string;
}): string {
  return [
    'Ambiguous Limina output build preset:',
    `  config: ${toRelativePath(options.projectRootDir, options.sourceConfigPath)}`,
    '  reason: multiple build-capable checker presets can produce output artifacts for this config.',
    '  fix: pass --preset with one of the available presets.',
    '  available presets:',
    ...options.availableCheckers.map((checker) => `    - ${checker}`),
  ].join('\n');
}

function formatOutputBuildTargetResolutionProblem(options: {
  matchingCheckers: ResolvedCheckerConfig[];
  projectRootDir: string;
  resolutionKind: OutputBuildResolutionKind;
  sourceConfigPath: string;
}): string {
  const configLine = `  config: ${toRelativePath(options.projectRootDir, options.sourceConfigPath)}`;

  if (options.resolutionKind === 'unmanaged') {
    return [
      'Unmanaged Limina output build config:',
      configLine,
      '  reason: limina build <config> only accepts source configs managed by Limina checker.include.',
      '  fix: add the owning tsconfig.json entry to a build-capable checker include, or use limina build <config> --raw --preset <checker> for a direct raw build.',
    ].join('\n');
  }

  if (options.resolutionKind === 'outputless-solution') {
    return [
      'No output-enabled source configs were found under this solution config.',
      configLine,
      '  reason: the solution is Limina-managed, but none of its recursive referenced source leaves declare liminaOptions.outputs.',
      '  fix: Add liminaOptions.outputs to at least one referenced source leaf.',
    ].join('\n');
  }

  if (options.resolutionKind === 'outputless-project') {
    return [
      'Missing Limina output build options:',
      configLine,
      '  reason: this Limina-managed source config does not declare liminaOptions.outputs.',
      '  fix: add liminaOptions.outputs to this source config, or use limina build <config> --raw --preset <checker> for a direct raw build.',
    ].join('\n');
  }

  return formatTypecheckOnlyBuildProblem({
    checkers: options.matchingCheckers,
    projectRootDir: options.projectRootDir,
    sourceConfigPath: options.sourceConfigPath,
  });
}

interface BuildTargetDescriptor {
  buildModule: GeneratedBuildModule;
  checker: ResolvedCheckerConfig;
  outputDeclarationCopyContexts?: GeneratedOutputDeclarationCopyContext[];
  sourceConfigPath: string;
}

type OutputBuildResolutionKind =
  | 'managed-output'
  | 'outputless-project'
  | 'outputless-solution'
  | 'typecheck-only'
  | 'unmanaged';

interface ResolveBuildTargetOptions {
  checker?: BuildCheckerPreset;
  config: ResolvedLiminaConfig;
  configPath?: string;
  providers?: AnalysisProviderSet;
  cwd: string;
  generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
  preflight?: LiminaPreflightManager;
  project?: string;
  raw?: boolean;
}

type ResolvedBuildTarget =
  | {
      availableCheckers: string[];
      allCheckers: ResolvedCheckerConfig[];
      checkerTargets: BuildTargetDescriptor[];
      generatedGraph: GeneratedTsconfigGraphResult;
      kind: 'managed';
      matchingCheckers: ResolvedCheckerConfig[];
      resolutionKind: OutputBuildResolutionKind;
      selectedChecker?: BuildCheckerPreset;
      sourceConfigPath: string;
    }
  | {
      checker: BuildCheckerPreset;
      kind: 'raw';
      targetConfigPath: string;
    };

interface BuildCheckerCombinationEntry {
  checker: ResolvedCheckerConfig;
  entryConfigPath: string;
  generatedConfigPath: string;
  sourceConfigPath: string;
}

function getBuildTargetDescriptorKey(
  descriptor: BuildTargetDescriptor,
): string {
  return `${descriptor.checker.name}\0${descriptor.sourceConfigPath}`;
}

function createRawBuildChecker(options: {
  preset: BuildCheckerPreset;
  projectRootDir: string;
}): ResolvedCheckerConfig {
  return {
    exclude: [],
    extensions: getCheckerExtensions(
      {
        include: [],
        preset: options.preset,
      },
      {
        projectRootDir: options.projectRootDir,
      },
    ),
    include: [],
    name: options.preset,
    preset: options.preset,
  };
}

function collectManagedDeclarationBuildTargets(options: {
  allCheckers: ResolvedCheckerConfig[];
  generatedGraph: GeneratedTsconfigGraphResult;
  sourceConfigPath: string;
}): BuildTargetDescriptor[] {
  return options.allCheckers.flatMap((checker) => {
    const buildModule = options.generatedGraph.sourceToBuild
      .get(checker.name)
      ?.get(options.sourceConfigPath);

    if (!buildModule) {
      return [];
    }

    return [
      {
        buildModule,
        checker,
        sourceConfigPath: options.sourceConfigPath,
      },
    ];
  });
}

function getOutputDeclarationCopyContexts(options: {
  checkerName: string;
  generatedGraph: GeneratedTsconfigGraphResult;
  sourceConfigPath: string;
}): GeneratedOutputDeclarationCopyContext[] | undefined {
  const copyContexts = options.generatedGraph.outputDeclarationCopies
    .get(options.checkerName)
    ?.get(options.sourceConfigPath);

  return copyContexts && copyContexts.length > 0
    ? copyContexts.map((copyContext) => ({ ...copyContext }))
    : undefined;
}

function collectManagedOutputBuildTargets(options: {
  allCheckers: ResolvedCheckerConfig[];
  generatedGraph: GeneratedTsconfigGraphResult;
  sourceConfigPath: string;
}): BuildTargetDescriptor[] {
  return options.allCheckers.flatMap((checker) => {
    const buildModule = options.generatedGraph.configToOutputBuild
      .get(checker.name)
      ?.get(options.sourceConfigPath);

    if (!buildModule) {
      return [];
    }

    return [
      {
        buildModule,
        checker,
        outputDeclarationCopyContexts: getOutputDeclarationCopyContexts({
          checkerName: checker.name,
          generatedGraph: options.generatedGraph,
          sourceConfigPath: options.sourceConfigPath,
        }),
        sourceConfigPath: options.sourceConfigPath,
      },
    ];
  });
}

async function resolveBuildTarget(
  options: ResolveBuildTargetOptions,
): Promise<ResolvedBuildTarget> {
  const projectRootDir = normalizeAbsolutePath(options.config.rootDir);
  const targetConfigPath = resolveBuildConfigPath({
    configPath: options.configPath,
    cwd: options.cwd,
    project: options.project,
    rootDir: projectRootDir,
  });

  if (options.raw) {
    if (!options.checker) {
      throw new Error(
        [
          'Invalid raw build invocation:',
          `  config: ${toRelativePath(projectRootDir, targetConfigPath)}`,
          '  reason: limina build --raw requires --preset.',
        ].join('\n'),
      );
    }

    if (targetConfigPath.split(path.sep).includes('.limina')) {
      throw new Error(
        [
          'Invalid raw build config:',
          `  config: ${toRelativePath(projectRootDir, targetConfigPath)}`,
          '  reason: raw build expects a user-authored tsconfig, not a .limina generated config.',
        ].join('\n'),
      );
    }

    return {
      checker: options.checker,
      kind: 'raw',
      targetConfigPath,
    };
  }

  const generatedGraph = (
    await resolvePreflight(
      options.config,
      options,
    ).ensureGeneratedArtifactsMaterialized()
  ).graph;
  const allCheckers = generatedGraph.checkers;
  const declarationTargets = isOrdinarySourceTypecheckConfigPath(
    targetConfigPath,
  )
    ? collectManagedDeclarationBuildTargets({
        allCheckers,
        generatedGraph,
        sourceConfigPath: targetConfigPath,
      })
    : [];
  const outputTargets = isOrdinarySourceTypecheckConfigPath(targetConfigPath)
    ? collectManagedOutputBuildTargets({
        allCheckers,
        generatedGraph,
        sourceConfigPath: targetConfigPath,
      })
    : [];

  const buildCapableTargets = outputTargets.filter(
    ({ checker }) => getCheckerAdapter(checker.preset)?.execution === 'build',
  );
  const buildCapableDeclarationTargets = declarationTargets.filter(
    ({ checker }) => getCheckerAdapter(checker.preset)?.execution === 'build',
  );
  const availableCheckers = uniqueSortedStrings(
    buildCapableTargets.map(({ checker }) => checker.preset),
  );
  const checkerTargets = options.checker
    ? buildCapableTargets.filter(
        ({ checker }) => checker.preset === options.checker,
      )
    : buildCapableTargets;
  const managedBuildModules = declarationTargets.length > 0;
  const targetBuildModuleKinds = uniqueSortedStrings(
    buildCapableDeclarationTargets.map(({ buildModule }) => buildModule.kind),
  );
  const resolutionKind =
    checkerTargets.length > 0
      ? 'managed-output'
      : managedBuildModules
        ? buildCapableDeclarationTargets.length === 0
          ? 'typecheck-only'
          : targetBuildModuleKinds.includes('solution')
            ? 'outputless-solution'
            : 'outputless-project'
        : 'unmanaged';

  return {
    availableCheckers,
    allCheckers,
    checkerTargets,
    generatedGraph,
    kind: 'managed',
    matchingCheckers: declarationTargets.map(({ checker }) => checker),
    resolutionKind,
    ...(options.checker ? { selectedChecker: options.checker } : {}),
    sourceConfigPath: targetConfigPath,
  };
}

function shouldWarnForBuildCheckerPresetCombination(
  presets: string[],
): boolean {
  const uniquePresets = uniqueSortedStrings(presets);

  if (uniquePresets.length <= 1) {
    return false;
  }

  return !uniquePresets.every(
    (preset) => preset === 'tsc' || preset === 'vue-tsc',
  );
}

function formatBuildCheckerCombinationWarning(options: {
  entries: BuildCheckerCombinationEntry[];
  projectRootDir: string;
}): string | null {
  const entriesByGeneratedConfigPath = new Map<
    string,
    BuildCheckerCombinationEntry[]
  >();

  for (const entry of options.entries) {
    entriesByGeneratedConfigPath.set(entry.generatedConfigPath, [
      ...(entriesByGeneratedConfigPath.get(entry.generatedConfigPath) ?? []),
      entry,
    ]);
  }

  const warningGroups = [...entriesByGeneratedConfigPath.entries()]
    .filter(([, entries]) =>
      shouldWarnForBuildCheckerPresetCombination(
        entries.map((entry) => entry.checker.preset),
      ),
    )
    .sort(([left], [right]) =>
      toRelativePath(options.projectRootDir, left).localeCompare(
        toRelativePath(options.projectRootDir, right),
      ),
    );

  if (warningGroups.length === 0) {
    return null;
  }

  return [
    'Potentially incompatible build checker combination:',
    '  reason: these checker presets can reach the same generated declaration config but do not safely share underlying build cache semantics.',
    '  fix: use a single cache-compatible build checker path for this generated config, or use a file-compatible tsc + vue-tsc combination.',
    ...warningGroups.flatMap(([generatedConfigPath, entries]) => [
      `  generated config: ${toRelativePath(options.projectRootDir, generatedConfigPath)}`,
      `  source config: ${toRelativePath(options.projectRootDir, entries[0]!.sourceConfigPath)}`,
      '  reachable from:',
      ...formatBuildCheckerCombinationReachability({
        entries,
        projectRootDir: options.projectRootDir,
      }),
    ]),
  ].join('\n');
}

function formatBuildCheckerCombinationReachability(options: {
  entries: BuildCheckerCombinationEntry[];
  projectRootDir: string;
}): string[] {
  const entriesByCheckerKey = new Map<
    string,
    {
      checker: ResolvedCheckerConfig;
      entryConfigPaths: Set<string>;
    }
  >();

  for (const entry of options.entries) {
    const key = `${entry.checker.name}\0${entry.checker.preset}`;
    const checkerEntries = entriesByCheckerKey.get(key) ?? {
      checker: entry.checker,
      entryConfigPaths: new Set<string>(),
    };

    checkerEntries.entryConfigPaths.add(entry.entryConfigPath);
    entriesByCheckerKey.set(key, checkerEntries);
  }

  return [...entriesByCheckerKey.values()]
    .sort(
      (left, right) =>
        left.checker.name.localeCompare(right.checker.name) ||
        left.checker.preset.localeCompare(right.checker.preset),
    )
    .flatMap(({ checker, entryConfigPaths }) => [
      `    - config.checkers.${checker.name} (${checker.preset})`,
      '      entry tsconfigs:',
      ...[...entryConfigPaths]
        .sort((left, right) =>
          toRelativePath(options.projectRootDir, left).localeCompare(
            toRelativePath(options.projectRootDir, right),
          ),
        )
        .map(
          (entryConfigPath) =>
            `        - ${toRelativePath(options.projectRootDir, entryConfigPath)}`,
        ),
    ]);
}

function getSourceConfigPathForGeneratedDts(options: {
  dtsConfigPath: string;
  generatedGraph: GeneratedTsconfigGraphResult;
}): string | null {
  for (const dtsToSource of options.generatedGraph.dtsToSource.values()) {
    const sourceConfigPath = dtsToSource.get(options.dtsConfigPath);

    if (sourceConfigPath) {
      return sourceConfigPath;
    }
  }

  return null;
}

function getSourceConfigPathForBuildConfig(options: {
  checkerName: string;
  configPath: string;
  generatedGraph: GeneratedTsconfigGraphResult;
}): string | null {
  const sourceToBuild =
    options.generatedGraph.sourceToBuild.get(options.checkerName) ?? new Map();

  for (const [sourceConfigPath, buildModule] of sourceToBuild) {
    if (buildModule.path === options.configPath) {
      return sourceConfigPath;
    }
  }

  if (!isDtsConfigPath(options.configPath)) {
    return null;
  }

  return getSourceConfigPathForGeneratedDts({
    dtsConfigPath: options.configPath,
    generatedGraph: options.generatedGraph,
  });
}

function collectCheckerBuildCombinationRoots(options: {
  checkers: ResolvedCheckerConfig[];
  generatedGraph: GeneratedTsconfigGraphResult;
  projectRootDir: string;
}): {
  checker: ResolvedCheckerConfig;
  configPath: string;
  entryConfigPath: string;
}[] {
  return options.checkers.flatMap((checker) => {
    const checkerEntryPath = options.generatedGraph.checkerEntries.get(
      checker.name,
    );

    if (!checkerEntryPath) {
      return [];
    }

    return getRawReferencePathsForConfig(
      options.projectRootDir,
      checkerEntryPath,
    ).flatMap((configPath) => {
      const entryConfigPath = getSourceConfigPathForBuildConfig({
        checkerName: checker.name,
        configPath,
        generatedGraph: options.generatedGraph,
      });

      return entryConfigPath
        ? [
            {
              checker,
              configPath,
              entryConfigPath,
            },
          ]
        : [];
    });
  });
}

function collectBuildGraphCombinationEntries(options: {
  generatedGraph: GeneratedTsconfigGraphResult;
  projectRootDir: string;
  roots: {
    checker: ResolvedCheckerConfig;
    configPath: string;
    entryConfigPath: string;
  }[];
}): BuildCheckerCombinationEntry[] {
  const entries: BuildCheckerCombinationEntry[] = [];

  for (const root of options.roots) {
    const route = collectGraphProjectRouteFromRoot({
      rootConfigPath: root.configPath,
      rootDir: options.projectRootDir,
    });

    for (const generatedConfigPath of route.projectPaths.filter(
      isDtsConfigPath,
    )) {
      const sourceConfigPath = getSourceConfigPathForGeneratedDts({
        dtsConfigPath: generatedConfigPath,
        generatedGraph: options.generatedGraph,
      });

      if (!sourceConfigPath) {
        continue;
      }

      entries.push({
        checker: root.checker,
        entryConfigPath: root.entryConfigPath,
        generatedConfigPath,
        sourceConfigPath,
      });
    }
  }

  return entries;
}

function reportBuildCheckerCombinationWarning(options: {
  entries: BuildCheckerCombinationEntry[];
  flow?: LiminaFlowReporter;
  flowDepth: number;
  projectRootDir: string;
  report?: CheckIssueReportOptions;
}): void {
  const warning = formatBuildCheckerCombinationWarning(options);

  if (!warning) {
    return;
  }

  options.flow?.warn(warning, {
    depth: options.flowDepth + 1,
    persistInteractive: true,
  });

  if (options.flow?.interactive || !shouldLogCheckReport(options.report)) {
    return;
  }

  TypecheckLogger.warn(warning);
}

function collectBuildTargetProviderClosure(options: {
  allCheckers: ResolvedCheckerConfig[];
  generatedGraph: GeneratedTsconfigGraphResult;
  initialTargets: BuildTargetDescriptor[];
}): BuildTargetDescriptor[] {
  const checkerByName = new Map(
    options.allCheckers.map((checker) => [checker.name, checker]),
  );
  const descriptorsByKey = new Map<string, BuildTargetDescriptor>();
  const queue: BuildTargetDescriptor[] = [];

  for (const target of options.initialTargets) {
    const key = getBuildTargetDescriptorKey(target);

    descriptorsByKey.set(key, target);
    queue.push(target);
  }

  for (;;) {
    const current = queue.shift();

    if (!current) {
      break;
    }

    for (const edge of options.generatedGraph.providerEdges) {
      if (
        edge.fromChecker !== current.checker.name ||
        edge.fromConfigPath !== current.sourceConfigPath
      ) {
        continue;
      }

      const checker = checkerByName.get(edge.toChecker);

      if (
        !checker ||
        getCheckerAdapter(checker.preset)?.execution !== 'build'
      ) {
        continue;
      }

      const buildModule = options.generatedGraph.configToOutputBuild
        .get(checker.name)
        ?.get(edge.toConfigPath);

      if (!buildModule) {
        continue;
      }

      const descriptor: BuildTargetDescriptor = {
        buildModule,
        checker,
        outputDeclarationCopyContexts: getOutputDeclarationCopyContexts({
          checkerName: checker.name,
          generatedGraph: options.generatedGraph,
          sourceConfigPath: edge.toConfigPath,
        }),
        sourceConfigPath: edge.toConfigPath,
      };
      const key = getBuildTargetDescriptorKey(descriptor);

      if (descriptorsByKey.has(key)) {
        continue;
      }

      descriptorsByKey.set(key, descriptor);
      queue.push(descriptor);
    }
  }

  return [...descriptorsByKey.values()].sort(
    (left, right) =>
      left.checker.name.localeCompare(right.checker.name) ||
      left.sourceConfigPath.localeCompare(right.sourceConfigPath),
  );
}

function collectOutputDeclarationCopyContexts(
  descriptors: readonly BuildTargetDescriptor[],
): GeneratedOutputDeclarationCopyContext[] {
  const contextsByKey = new Map<
    string,
    GeneratedOutputDeclarationCopyContext
  >();

  for (const descriptor of descriptors) {
    for (const copyContext of descriptor.outputDeclarationCopyContexts ?? []) {
      const key = [
        copyContext.sourceConfigPath,
        copyContext.rootDir,
        copyContext.outDir,
      ].join('\0');

      contextsByKey.set(key, copyContext);
    }
  }

  return [...contextsByKey.values()].sort((left, right) =>
    left.sourceConfigPath.localeCompare(right.sourceConfigPath),
  );
}

async function runOutputDeclarationCopyPostBuild(options: {
  buildTargetDescriptors: readonly BuildTargetDescriptor[];
  flow?: LiminaFlowReporter;
  flowDepth: number;
  projectRootDir: string;
  report?: CheckIssueReportOptions;
  workspaceContext: ValidatedWorkspaceContext;
}): Promise<string | null> {
  const copyContexts = collectOutputDeclarationCopyContexts(
    options.buildTargetDescriptors,
  );

  if (copyContexts.length === 0) {
    return null;
  }

  const plan = mergeOutputDeclarationCopyPlans(
    copyContexts.map((copyContext) => {
      const capability =
        options.workspaceContext.outputMutationAuthorities?.get(
          normalizeAbsolutePath(copyContext.sourceConfigPath),
        );
      if (
        !capability ||
        capability.outputRoot !== normalizeAbsolutePath(copyContext.outDir) ||
        capability.workspaceGeneration !==
          options.workspaceContext.workspaceMutationGeneration
      ) {
        throw new Error(
          `Missing validated declaration output authority for ${copyContext.sourceConfigPath}.`,
        );
      }
      return createOutputDeclarationCopyPlan({
        authority: capability.authority,
        fileNames: copyContext.fileNames,
        outDir: copyContext.outDir,
        projectRootDir: options.projectRootDir,
        rootDir: copyContext.rootDir,
      });
    }),
  );
  const warning = formatOutputDeclarationCopyWarnings({
    problems: plan.problems,
    projectRootDir: options.projectRootDir,
  });

  if (warning) {
    options.flow?.warn(warning, {
      depth: options.flowDepth + 1,
      persistInteractive: true,
    });

    if (shouldLogCheckReport(options.report) && !options.flow?.interactive) {
      TypecheckLogger.warn(warning);
    }
  }

  try {
    await copyOutputDeclarationInputs(plan, {
      projectRootDir: options.projectRootDir,
      requireAuthenticatedAuthorities: true,
    });
  } catch (error) {
    const problem =
      error instanceof OutputDeclarationCopyError
        ? (formatOutputDeclarationCopyErrors({
            problems: error.problems,
            projectRootDir: options.projectRootDir,
          }) ?? error.message)
        : formatErrorMessage(error);

    if (shouldLogCheckReport(options.report)) {
      TypecheckLogger.error(
        formatTypecheckProblemSummaryReport({
          pluralIssueLabel: 'output declaration copy issues',
          problems: [problem],
          singularIssueLabel: 'output declaration copy issue',
          title: 'Build summary',
        }),
      );
    }

    return problem;
  }

  return null;
}

export async function runBuildImpl(
  options: RunBuildOptions,
): Promise<RunBuildResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const projectRootDir = normalizeAbsolutePath(options.config.rootDir);
  const preflight = resolvePreflight(options.config, options);
  const workspaceContext = await preflight.ensureWorkspaceValidated();
  const resolvedTarget = await resolveBuildTarget({
    checker: options.checker,
    config: options.config,
    configPath: options.configPath,
    providers: options.providers,
    cwd,
    generatedGraphProvider: options.generatedGraphProvider,
    preflight,
    project: options.project,
    raw: options.raw,
  });
  const flowDepth = options.flowDepth ?? 0;
  const rootConfigPaths: string[] = [];

  if (resolvedTarget.kind === 'raw') {
    const checker = createRawBuildChecker({
      preset: resolvedTarget.checker,
      projectRootDir,
    });
    const problems = collectCheckerPeerDependencyProblems({
      checkers: [checker],
      imports: options.config.config?.imports,
      projectRootDir,
      resolvePackage: options.checkerPackageResolver,
    });

    if (problems.length > 0) {
      options.flow?.fail('checker dependency preflight failed', {
        depth: flowDepth + 1,
      });
      if (shouldLogCheckReport(options.report)) {
        TypecheckLogger.error(
          formatTypecheckProblemSummaryReport({
            pluralIssueLabel: 'build issues',
            problems,
            singularIssueLabel: 'build issue',
            title: 'Build summary',
          }),
        );
      }

      return {
        failedTargets: [],
        failureKind: 'peer-dependency',
        passed: false,
        problems,
        projectRootDir,
        rootConfigPaths,
        sourceConfigPath: null,
      };
    }

    rootConfigPaths.push(resolvedTarget.targetConfigPath);

    const target = {
      ...createCheckerTarget({
        checker,
        commandOverride: options.tscCommand,
        configPath: resolvedTarget.targetConfigPath,
        executionKind: 'build',
        projectRootDir,
        sourceConfigPath: resolvedTarget.targetConfigPath,
        watch: options.watch,
      }),
      sourceConfigPath: resolvedTarget.targetConfigPath,
    };
    const targetTasks = new Map<CheckerTargetId, LiminaFlowTask>();

    if (shouldLogCheckReport(options.report)) {
      TypecheckLogger.info(
        [
          'Running raw build target.',
          `Checker: ${resolvedTarget.checker}`,
          `Config: ${toRelativePath(projectRootDir, resolvedTarget.targetConfigPath)}`,
          `CWD: ${toRelativePath(cwd, projectRootDir)}`,
        ].join('\n'),
      );
    }

    const results = await runBuildTargets(
      [target],
      [],
      resolveTypecheckRunner(options),
      {
        config: options.config,
        onTargetResult: (target, result) => {
          const task = targetTasks.get(target.id);

          if (!task) {
            return;
          }

          completeCheckerTargetTask(task, result);
        },
        onTargetStart: (target) => {
          if (!options.flow) {
            return;
          }

          targetTasks.set(
            target.id,
            options.flow.start(
              target.label ??
                `build: ${toRelativePath(projectRootDir, target.configPath)}`,
              {
                collapseOnSuccess: false,
                depth: flowDepth + 1,
              },
            ),
          );
        },
        watch: options.watch,
      },
    );
    const failedResults = results.filter((result) => result.status !== 0);
    const passed = failedResults.length === 0;

    if (!passed) {
      if (shouldLogCheckReport(options.report)) {
        TypecheckLogger.error(
          formatFailedTargetSummaryReport({
            failedResults,
            heading: 'build failed:',
            pluralIssueLabel: 'failed build targets',
            projectRootDir,
            singularIssueLabel: 'failed build target',
            title: 'Build summary',
          }),
        );
      }
    } else if (
      shouldLogCheckReport(options.report) &&
      !options.flow?.interactive
    ) {
      TypecheckLogger.success('Built 1 raw target.');
    }

    return {
      failedTargets: collectFailedCheckerTargets([target], failedResults),
      passed,
      projectRootDir,
      rootConfigPaths,
      sourceConfigPath: null,
    };
  }

  if (resolvedTarget.checkerTargets.length === 0) {
    const selectionProblem = resolvedTarget.selectedChecker
      ? formatManagedBuildCheckerSelectionProblem({
          availableCheckers: resolvedTarget.availableCheckers,
          commandLabel: 'build',
          projectRootDir,
          selectedChecker: resolvedTarget.selectedChecker,
          sourceConfigPath: resolvedTarget.sourceConfigPath,
        })
      : formatOutputBuildTargetResolutionProblem({
          matchingCheckers: resolvedTarget.matchingCheckers,
          projectRootDir,
          resolutionKind: resolvedTarget.resolutionKind,
          sourceConfigPath: resolvedTarget.sourceConfigPath,
        });

    if (shouldLogCheckReport(options.report)) {
      TypecheckLogger.error(
        formatCheckIssueSummaryReport({
          details: selectionProblem,
          issueCount: 1,
          pluralIssueLabel: 'build selection issues',
          singularIssueLabel: 'build selection issue',
          title: 'Build summary',
        }),
      );
    }

    return {
      failedTargets: [],
      failureKind: 'target-selection',
      passed: false,
      problems: [selectionProblem],
      projectRootDir,
      rootConfigPaths,
      sourceConfigPath: resolvedTarget.sourceConfigPath,
    };
  }

  if (
    !resolvedTarget.selectedChecker &&
    resolvedTarget.checkerTargets.length > 1
  ) {
    const selectionProblem = formatMultipleOutputBuildPresetProblem({
      availableCheckers: resolvedTarget.availableCheckers,
      projectRootDir,
      sourceConfigPath: resolvedTarget.sourceConfigPath,
    });

    if (shouldLogCheckReport(options.report)) {
      TypecheckLogger.error(
        formatCheckIssueSummaryReport({
          details: selectionProblem,
          issueCount: 1,
          pluralIssueLabel: 'build selection issues',
          singularIssueLabel: 'build selection issue',
          title: 'Build summary',
        }),
      );
    }

    return {
      failedTargets: [],
      failureKind: 'target-selection',
      passed: false,
      problems: [selectionProblem],
      projectRootDir,
      rootConfigPaths,
      sourceConfigPath: resolvedTarget.sourceConfigPath,
    };
  }

  const buildTargetDescriptors = collectBuildTargetProviderClosure({
    allCheckers: resolvedTarget.allCheckers,
    generatedGraph: resolvedTarget.generatedGraph,
    initialTargets: resolvedTarget.checkerTargets,
  });

  const problems = collectCheckerPeerDependencyProblems({
    checkers: buildTargetDescriptors.map(({ checker }) => checker),
    imports: options.config.config?.imports,
    projectRootDir,
    resolvePackage: options.checkerPackageResolver,
  });

  if (problems.length > 0) {
    options.flow?.fail('checker dependency preflight failed', {
      depth: flowDepth + 1,
    });
    if (shouldLogCheckReport(options.report)) {
      TypecheckLogger.error(
        formatTypecheckProblemSummaryReport({
          pluralIssueLabel: 'checker build issues',
          problems,
          singularIssueLabel: 'checker build issue',
          title: 'Checker build summary',
        }),
      );
    }

    return {
      failedTargets: [],
      passed: false,
      projectRootDir,
      rootConfigPaths,
      sourceConfigPath: resolvedTarget.sourceConfigPath,
    };
  }

  const targets = buildTargetDescriptors.map(
    ({ buildModule, checker, sourceConfigPath }) => {
      rootConfigPaths.push(buildModule.path);

      return {
        ...createCheckerTarget({
          checker,
          commandOverride: options.tscCommand,
          configPath: buildModule.path,
          executionKind: 'build',
          projectRootDir,
          sourceConfigPath,
          watch: options.watch,
        }),
        sourceConfigPath,
      };
    },
  );

  options.flow?.info(`found ${targets.length} build target(s)`, {
    depth: flowDepth + 1,
  });

  if (shouldLogCheckReport(options.report)) {
    TypecheckLogger.info(
      [
        `Running build for ${targets.length} generated target(s).`,
        `Source: ${toRelativePath(projectRootDir, resolvedTarget.sourceConfigPath)}`,
        `CWD: ${toRelativePath(cwd, projectRootDir)}`,
        `Entries: ${rootConfigPaths
          .map((configPath) => toRelativePath(projectRootDir, configPath))
          .join(', ')}`,
      ].join('\n'),
    );
  }

  const targetTasks = new Map<CheckerTargetId, LiminaFlowTask>();
  const mutationCoordinator = await ManagedCheckerMutationCoordinator.create({
    artifactNamespace: preflight.artifactNamespace,
    checkers: resolvedTarget.allCheckers,
    config: options.config,
    generatedGraph: resolvedTarget.generatedGraph,
    targets,
    workspaceContext,
  });
  const results = await runBuildTargets(
    targets,
    resolvedTarget.generatedGraph.providerEdges,
    resolveTypecheckRunner(options),
    {
      beforeLayerRun: (targets) => mutationCoordinator.beforeLayerRun(targets),
      beforeTargetRun: (target) => mutationCoordinator.beforeTargetRun(target),
      config: options.config,
      onTargetResult: (target, result) => {
        const task = targetTasks.get(target.id);

        if (!task) {
          return;
        }

        completeCheckerTargetTask(task, result);
      },
      onTargetStart: (target) => {
        if (!options.flow) {
          return;
        }

        targetTasks.set(
          target.id,
          options.flow.start(
            target.label ??
              `build: ${toRelativePath(projectRootDir, target.configPath)}`,
            {
              collapseOnSuccess: false,
              depth: flowDepth + 1,
            },
          ),
        );
      },
      watch: options.watch,
    },
  );
  const failedResults = results.filter((result) => result.status !== 0);
  const failedTargets = collectFailedCheckerTargets(targets, failedResults);
  const passed = failedResults.length === 0;

  if (!passed) {
    if (shouldLogCheckReport(options.report)) {
      TypecheckLogger.error(
        formatFailedTargetSummaryReport({
          failedResults,
          heading: 'build failed:',
          pluralIssueLabel: 'failed checker build targets',
          projectRootDir,
          singularIssueLabel: 'failed checker build target',
          title: 'Checker build summary',
        }),
      );
    }
  } else if (!options.watch) {
    const copyProblem = await runOutputDeclarationCopyPostBuild({
      buildTargetDescriptors,
      flow: options.flow,
      flowDepth,
      projectRootDir,
      report: options.report,
      workspaceContext,
    });

    if (copyProblem) {
      return {
        failedTargets,
        failureKind: 'process',
        passed: false,
        problems: [copyProblem],
        projectRootDir,
        rootConfigPaths,
        sourceConfigPath: resolvedTarget.sourceConfigPath,
      };
    }
  }

  if (
    passed &&
    shouldLogCheckReport(options.report) &&
    !options.flow?.interactive
  ) {
    TypecheckLogger.success(`Built ${targets.length} generated target(s).`);
  }

  return {
    failedTargets,
    passed,
    projectRootDir,
    rootConfigPaths,
    sourceConfigPath: resolvedTarget.sourceConfigPath,
  };
}

export async function runCheckerTypecheckImpl(
  options: RunCheckerTypecheckOptions,
): Promise<RunCheckerTypecheckResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const projectRootDir = normalizeAbsolutePath(options.config.rootDir);
  const preflight = resolvePreflight(options.config, options);
  await preflight.ensureWorkspaceValidated();
  const allCheckers = getActiveCheckers(options.config);
  const checkers = getExecutionCheckers({
    checkers: allCheckers,
    executionKind: 'typecheck',
  });
  const flowDepth = options.flowDepth ?? 0;
  const rootConfigPaths: string[] = [];

  if (checkers.length === 0) {
    if (options.progress) {
      options.progress.startItem('second-class checker entries').pass();
    } else {
      options.flow?.info('no second-class checker entries configured', {
        depth: flowDepth + 1,
      });
    }

    if (shouldLogCheckReport(options.report) && !options.flow?.interactive) {
      TypecheckLogger.success('No second-class checker entries configured.');
    }

    return {
      failedTargets: [],
      passed: true,
      projectRootDir,
      rootConfigPaths,
      targetResults: [],
    };
  }

  const problems = collectCheckerPeerDependencyProblems({
    checkers,
    imports: options.config.config?.imports,
    projectRootDir,
    resolvePackage: options.checkerPackageResolver,
  });

  if (problems.length > 0) {
    const preflightItem = options.progress?.startItem(
      'checker dependency preflight',
    );

    preflightItem?.fail();
    if (!options.progress) {
      options.flow?.fail('checker dependency preflight failed', {
        depth: flowDepth + 1,
      });
    }
    if (shouldLogCheckReport(options.report)) {
      TypecheckLogger.error(
        formatTypecheckProblemSummaryReport({
          pluralIssueLabel: 'checker typecheck issues',
          problems,
          singularIssueLabel: 'checker typecheck issue',
          title: 'Checker typecheck summary',
        }),
      );
    }

    return {
      failedTargets: [],
      failureKind: 'peer-dependency',
      passed: false,
      problems,
      projectRootDir,
      rootConfigPaths,
      targetResults: [],
    };
  }

  const generatedGraph = (
    await preflight.ensureGeneratedArtifactsMaterialized()
  ).graph;
  const targets = checkers.map((checker) => {
    const configPath = generatedGraph.checkerEntries.get(checker.name);

    if (!configPath) {
      throw new Error(`Missing generated entry for checker "${checker.name}".`);
    }

    rootConfigPaths.push(configPath);

    return createCheckerTarget({
      checker,
      commandOverride: options.tscCommand,
      configPath,
      executionKind: 'typecheck',
      projectRootDir,
    });
  });

  options.flow?.info(`found ${targets.length} checker typecheck entry(s)`, {
    depth: flowDepth + 1,
  });

  if (shouldLogCheckReport(options.report)) {
    TypecheckLogger.info(
      [
        `Running typecheck for ${targets.length} checker entry(s).`,
        `CWD: ${toRelativePath(cwd, projectRootDir)}`,
        `Entries: ${rootConfigPaths
          .map((configPath) => toRelativePath(projectRootDir, configPath))
          .join(', ')}`,
      ].join('\n'),
    );
  }

  const targetTasks: Map<string, CheckerFlowTask> = new Map(
    createPlannedCheckerTargetTasks(
      targets,
      options.progress,
      'checker typecheck',
      projectRootDir,
    ),
  );
  const runner = resolveTypecheckRunner(options);
  const cacheCoordinator = await VueTsgoCacheBatchCoordinator.prepare(targets);
  const onTargetStart = (target: TypecheckTarget): void => {
    if (options.progress) {
      (targetTasks.get(target.id) as TaskProgressItem | undefined)?.start();
      return;
    }

    if (!options.flow) {
      return;
    }

    targetTasks.set(
      target.id,
      options.flow.start(
        getCheckerTargetFlowLabel(target, 'checker typecheck', projectRootDir),
        {
          collapseOnSuccess: false,
          depth: flowDepth + 1,
        },
      ),
    );
  };
  const results = await runPool<TypecheckTarget, TypecheckTargetResult>({
    concurrency: resolveCheckerTypecheckConcurrency({
      config: options.config,
      itemCount: targets.length,
    }),
    items: targets,
    onError: (target, error) => ({
      configPath: target.configPath,
      durationMs: 0,
      error: error instanceof Error ? error : new Error(String(error)),
      id: target.id,
      status: 1,
    }),
    onResult: (target, result) => {
      const task = targetTasks.get(target.id);

      if (!task) {
        return;
      }

      completeCheckerTargetTask(task, result);
    },
    run: async (target) => {
      await cacheCoordinator.beforeTargetRun(target);
      onTargetStart(target);
      return runTargetWithMeasuredDuration(runner, target);
    },
  });
  const failedResults = results.filter((result) => result.status !== 0);
  const failedTargets = collectFailedCheckerTargets(targets, failedResults);
  const passed = failedResults.length === 0;

  if (!passed) {
    if (shouldLogCheckReport(options.report)) {
      TypecheckLogger.error(
        formatFailedTargetSummaryReport({
          failedResults,
          heading: 'typecheck checks failed:',
          pluralIssueLabel: 'failed checker typecheck targets',
          projectRootDir,
          singularIssueLabel: 'failed checker typecheck target',
          title: 'Checker typecheck summary',
        }),
      );
    }
  } else if (
    shouldLogCheckReport(options.report) &&
    !options.flow?.interactive
  ) {
    TypecheckLogger.success(
      `Checked ${targets.length} checker typecheck entry(s).`,
    );
  }

  return {
    failedTargets,
    passed,
    projectRootDir,
    rootConfigPaths,
    targetResults: results,
  };
}
