import { getCheckerAdapter } from '#checkers';
import type {
  BuiltinTaskName,
  PipelineStep,
  ResolvedCheckerConfig,
  ResolvedLiminaConfig,
} from '#config/runner';
import { getActiveCheckers, isAutoCheckerConfigMode } from '#config/runner';
import type { AnalysisProviderSet } from '#core';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import { toRelativePath } from '#utils/path';
import { prependPathEntry, shouldUseShellForCommand } from '#utils/process';
import { spawn, spawnSync } from 'node:child_process';
import path from 'pathe';
import { LiminaStructuredError } from '../check-reporting/errors';
import type { CheckIssueReportOptions } from '../check-reporting/human';
import type {
  CheckRunRecorder,
  LiminaCheckRunTaskStats,
} from '../check-reporting/run-recorder';
import { createCheckItemStats } from '../check-reporting/stats';
import { runGraphCheck, runGraphPrepare } from '../commands/graph';
import { runPackageCheck } from '../commands/package';
import { runProofCheck } from '../commands/proof';
import { runReleaseCheck } from '../commands/release';
import { runSourceCheck } from '../commands/source';
import { runCheckerBuild, runCheckerTypecheck } from '../commands/typecheck';
import { runExecutionPlan, validateExecutionPlan } from '../execution/executor';
import type { TaskProgressReporter } from '../execution/progress';
import type { ResourceRequest } from '../execution/resources';
import {
  type CompletedRunOutcome,
  type ExecutionPlan,
  type ExecutionTask,
  type ExecutionTaskRunResult,
  type TaskId,
  taskId,
} from '../execution/tasks';
import type { LiminaFlowReporter, LiminaFlowTask } from '../flow';
import { LiminaPreflightManager } from '../preflight';
import type {
  SourceCheckIssue,
  SourceIssueReportOptions,
} from '../source-check/report';
import {
  createTaskFailureIssue,
  type LiminaCheckIssue,
} from '../source-check/snapshot';
import type { CheckerFailureTarget } from '../typecheck/runner';
import {
  prepareVueTsgoCache,
  type TypecheckTargetResult,
} from '../typecheck/targets';

export interface RunPipelineOptions {
  checkRunRecorder?: CheckRunRecorder;
  checkIssueReport?: CheckIssueReportOptions;
  providers?: AnalysisProviderSet;
  cwd?: string;
  flow?: LiminaFlowReporter;
  generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
  packageNames?: readonly string[];
  preflight?: LiminaPreflightManager;
  progress?: TaskProgressReporter;
  sourceIssueReport?: SourceIssueReportOptions;
  executionPlan?: ExecutionPlan;
}

type NormalizedPipelineStep = Exclude<PipelineStep, string>;

interface BuiltinTaskResult {
  issues: readonly LiminaCheckIssue[];
  passed: boolean;
  sourceSnapshot?: {
    issues: readonly SourceCheckIssue[];
    status: 'completed';
  };
  stats?: LiminaCheckRunTaskStats;
}

interface CheckerTaskStatsInput {
  failedTargets: readonly CheckerFailureTarget[];
  passed: boolean;
  problems?: readonly string[];
  projectRootDir: string;
  rootConfigPaths: readonly string[];
  targetResults: readonly TypecheckTargetResult[];
}

const builtInTaskNames = new Set<string>([
  'checker:build',
  'checker:typecheck',
  'graph:check',
  'graph:prepare',
  'package:check',
  'proof:check',
  'release:check',
  'source:check',
]);

const defaultCheckPipeline: PipelineStep[] = [
  'graph:check',
  'source:check',
  'proof:check',
  'checker:build',
  'checker:typecheck',
];

function reportCheckerCapabilities(
  config: ResolvedLiminaConfig,
  flow: LiminaFlowReporter | undefined,
  checkers: ResolvedCheckerConfig[] = getActiveCheckers(config),
): void {
  if (!flow) {
    return;
  }

  const buildExecution: string[] = [];
  const typecheckExecution: string[] = [];
  const sourceGraph: string[] = [];
  const noSourceGraph: string[] = [];

  for (const checker of checkers) {
    const adapter = getCheckerAdapter(checker.preset);
    const label = `${checker.name} (${checker.preset})`;

    if (adapter?.execution === 'build') {
      buildExecution.push(label);
    } else if (adapter?.execution === 'typecheck') {
      typecheckExecution.push(label);
    }

    if (adapter?.sourceGraph) {
      sourceGraph.push(label);
    } else {
      noSourceGraph.push(label);
    }
  }

  flow.info(
    [
      'checker capability summary:',
      `  first-class build execution: ${buildExecution.length > 0 ? buildExecution.join(', ') : '(none)'}`,
      `  second-class typecheck execution: ${typecheckExecution.length > 0 ? typecheckExecution.join(', ') : '(none)'}`,
      `  source graph: ${sourceGraph.length > 0 ? sourceGraph.join(', ') : '(none)'}`,
      `  no source graph: ${noSourceGraph.length > 0 ? noSourceGraph.join(', ') : '(none)'}`,
      ...(typecheckExecution.length > 0
        ? [
            '  note: second-class checkers run through checker:typecheck; source graph participation is reported separately.',
          ]
        : []),
    ].join('\n'),
    { depth: 1 },
  );
}

function usesAutoCheckers(config: ResolvedLiminaConfig): boolean {
  return (
    config.config?.checkers === undefined ||
    isAutoCheckerConfigMode(config.config.checkers)
  );
}

async function reportAutoCheckerCapabilities(
  config: ResolvedLiminaConfig,
  flow: LiminaFlowReporter | undefined,
  preflight: LiminaPreflightManager,
): Promise<void> {
  if (!flow) {
    return;
  }

  try {
    reportCheckerCapabilities(
      config,
      flow,
      (await preflight.ensureGeneratedGraph()).checkers,
    );
  } catch {
    // The summary is informational. If generated graph discovery already failed
    // inside the execution tasks, do not rethrow and replace the task failure.
  }
}

function createSourceIssueReportOptions(
  options: RunPipelineOptions,
): SourceIssueReportOptions | undefined {
  if (!options.sourceIssueReport && !options.packageNames?.length) {
    return undefined;
  }

  return {
    ...options.sourceIssueReport,
    packageNames:
      options.sourceIssueReport?.packageNames ?? options.packageNames,
  };
}

function isBuiltinTaskName(value: string): value is BuiltinTaskName {
  return builtInTaskNames.has(value);
}

function assertNeverTaskName(taskName: never): never {
  throw new Error(`Unsupported built-in task: ${taskName}`);
}

function getPipelineStepLabel(step: NormalizedPipelineStep): string {
  if (step.type === 'task') {
    return step.name;
  }

  return [step.command, ...(step.args ?? [])].join(' ');
}

function getPipelineSteps(
  config: ResolvedLiminaConfig,
  pipelineName: string,
): readonly PipelineStep[] {
  const steps = config.pipelines?.[pipelineName];

  if (!steps) {
    throw new Error(
      [
        `Pipeline instruction "${pipelineName}" was not found.`,
        `Define it in ${path.relative(config.rootDir, config.configPath)} under the "pipelines" field, then run "limina check ${pipelineName}" again.`,
      ].join('\n'),
    );
  }

  if (steps.length === 0) {
    throw new Error(
      `Pipeline "${pipelineName}" must contain at least one step.`,
    );
  }

  return steps;
}

function createCommandStepEnvironment(
  cwd: string,
  step: Extract<PipelineStep, { type: 'command' }>,
): NodeJS.ProcessEnv {
  return prependPathEntry(
    {
      ...process.env,
      ...step.env,
    },
    path.join(cwd, 'node_modules/.bin'),
  );
}

function isVueTsgoCommand(command: string): boolean {
  const commandName = path.basename(command).toLowerCase();

  return commandName === 'vue-tsgo' || commandName === 'vue-tsgo.cmd';
}

function collectVueTsgoCommandConfigPaths(
  step: Extract<PipelineStep, { type: 'command' }>,
  cwd: string,
): string[] {
  if (!isVueTsgoCommand(step.command)) {
    return [];
  }

  const args = step.args ?? [];
  const configPaths: string[] = [];

  for (const [index, arg] of args.entries()) {
    if (
      arg !== '--build' &&
      arg !== '-b' &&
      arg !== '--project' &&
      arg !== '-p'
    ) {
      continue;
    }

    const configArg = args[index + 1];

    if (!configArg || configArg.startsWith('-')) {
      continue;
    }

    configPaths.push(path.resolve(cwd, configArg));
  }

  return configPaths.length > 0
    ? configPaths
    : [path.resolve(cwd, 'tsconfig.json')];
}

async function prepareCommandStepCache(
  step: Extract<PipelineStep, { type: 'command' }>,
  cwd: string,
): Promise<void> {
  await Promise.all(
    collectVueTsgoCommandConfigPaths(step, cwd).map((configPath) =>
      prepareVueTsgoCache({
        args: step.args ?? [],
        command: step.command,
        configPath,
        cwd,
      }),
    ),
  );
}

function createCheckerTaskStats(
  result: CheckerTaskStatsInput,
): LiminaCheckRunTaskStats {
  if (result.rootConfigPaths.length === 0) {
    const issues = result.passed
      ? 0
      : Math.max(1, result.problems?.length ?? 1);

    return {
      items: [
        createCheckItemStats({
          issues,
          name: result.passed
            ? 'second-class checker entries'
            : 'checker dependency preflight',
          total: result.passed ? 0 : 1,
        }),
      ],
      passed: 0,
      total: result.passed ? 0 : 1,
    };
  }

  const targetNamesById = new Map(
    result.targetResults.map((targetResult) => [
      targetResult.id,
      formatCheckerEntryName(result.projectRootDir, targetResult.configPath),
    ]),
  );

  return {
    items: result.targetResults.map((targetResult) => {
      const item = createCheckItemStats({
        durationMs: targetResult.durationMs,
        issues: targetResult.status === 0 ? 0 : 1,
        name: formatCheckerEntryName(
          result.projectRootDir,
          targetResult.configPath,
        ),
        total: 1,
      });
      return {
        ...item,
        id: targetResult.id,
        itemKind: 'checker-target' as const,
        ...(targetResult?.blockedBy
          ? {
              blockedBy: targetResult.blockedBy.map((id) => ({
                id,
                name: targetNamesById.get(id) ?? id,
              })),
              status: 'blocked' as const,
            }
          : {
              status:
                targetResult.status === 0
                  ? ('passed' as const)
                  : ('failed' as const),
            }),
      };
    }),
    passed: Math.max(
      0,
      result.targetResults.filter((target) => target.status === 0).length,
    ),
    total: result.targetResults.length,
  };
}

function createCommandTaskStats(options: {
  durationMs: number;
  passed: boolean;
}): LiminaCheckRunTaskStats {
  return {
    items: [
      createCheckItemStats({
        durationMs: options.durationMs,
        issues: options.passed ? 0 : 1,
        name: 'command execution',
        total: 1,
      }),
    ],
    passed: options.passed ? 1 : 0,
    total: 1,
  };
}

function formatCheckerEntryName(
  projectRootDir: string,
  configPath: string,
): string {
  const relativePath = toRelativePath(projectRootDir, configPath);
  const checkerEntryMatch = /^\.limina\/tsconfig\/checkers\/([^/]+)\//u.exec(
    relativePath,
  );

  return checkerEntryMatch
    ? `${checkerEntryMatch[1]} checker entry`
    : relativePath;
}

async function runBuiltinTask(
  config: ResolvedLiminaConfig,
  taskName: BuiltinTaskName,
  options: RunPipelineOptions = {},
): Promise<BuiltinTaskResult> {
  const issues: LiminaCheckIssue[] = [];
  const sourceIssues: SourceCheckIssue[] = [];
  let stats: LiminaCheckRunTaskStats | undefined;
  const onStats = (nextStats: LiminaCheckRunTaskStats): void => {
    stats = nextStats;
  };

  try {
    switch (taskName) {
      case 'graph:check': {
        const passed = await runGraphCheck(config, {
          clearScreen: false,
          providers: options.providers,
          deferSnapshot: true,
          flow: options.flow,
          flowDepth: 1,
          generatedGraphProvider: options.generatedGraphProvider,
          issues,
          onStats,
          preflight: options.preflight,
          progress: options.progress,
          report: options.checkIssueReport,
        });

        return { issues, passed, stats };
      }
      case 'graph:prepare': {
        const passed = await runGraphPrepare(config, {
          clearScreen: false,
          providers: options.providers,
          deferSnapshot: true,
          flow: options.flow,
          flowDepth: 1,
          generatedGraphProvider: options.generatedGraphProvider,
          issues,
          preflight: options.preflight,
          progress: options.progress,
          report: options.checkIssueReport,
        });

        return { issues, passed, stats };
      }
      case 'proof:check': {
        const passed = await runProofCheck(config, {
          clearScreen: false,
          providers: options.providers,
          deferSnapshot: true,
          flow: options.flow,
          flowDepth: 1,
          generatedGraphProvider: options.generatedGraphProvider,
          issues,
          onStats,
          preflight: options.preflight,
          progress: options.progress,
          report: options.checkIssueReport,
        });

        return { issues, passed, stats };
      }
      case 'source:check': {
        let authoritativeSourceIssues: readonly SourceCheckIssue[] | undefined;
        const passed = await runSourceCheck(config, {
          clearScreen: false,
          providers: options.providers,
          deferSnapshot: true,
          flow: options.flow,
          flowDepth: 1,
          generatedGraphProvider: options.generatedGraphProvider,
          issues,
          onStats,
          onSourceSnapshot: (nextIssues) => {
            authoritativeSourceIssues = [...nextIssues];
          },
          preflight: options.preflight,
          progress: options.progress,
          report: createSourceIssueReportOptions(options),
          sourceIssues,
        });

        return {
          issues: authoritativeSourceIssues ? [] : issues,
          passed,
          ...(authoritativeSourceIssues
            ? {
                sourceSnapshot: {
                  issues: authoritativeSourceIssues,
                  status: 'completed' as const,
                },
              }
            : {}),
          stats,
        };
      }
      case 'package:check': {
        const passed = await runPackageCheck({
          clearScreen: false,
          config,
          providers: options.providers,
          cwd: options.cwd,
          deferSnapshot: true,
          flow: options.flow,
          flowDepth: 1,
          issues,
          onStats,
          packageNames: options.packageNames,
          preflight: options.preflight,
          progress: options.progress,
          report: options.checkIssueReport,
        });

        return { issues, passed, stats };
      }
      case 'release:check': {
        const passed = await runReleaseCheck({
          clearScreen: false,
          config,
          providers: options.providers,
          cwd: options.cwd,
          deferSnapshot: true,
          flow: options.flow,
          flowDepth: 1,
          issues,
          onStats,
          packageNames: options.packageNames,
          preflight: options.preflight,
          progress: options.progress,
          report: options.checkIssueReport,
        });

        return { issues, passed, stats };
      }
      case 'checker:typecheck': {
        const result = await runCheckerTypecheck({
          clearScreen: false,
          config,
          providers: options.providers,
          cwd: config.rootDir,
          deferSnapshot: true,
          flow: options.flow,
          flowDepth: 1,
          generatedGraphProvider: options.generatedGraphProvider,
          issues,
          preflight: options.preflight,
          progress: options.progress,
          report: options.checkIssueReport,
        });

        return {
          issues,
          passed: result.passed,
          stats: createCheckerTaskStats(result),
        };
      }
      case 'checker:build': {
        const result = await runCheckerBuild({
          clearScreen: false,
          config,
          providers: options.providers,
          cwd: config.rootDir,
          deferSnapshot: true,
          flow: options.flow,
          flowDepth: 1,
          generatedGraphProvider: options.generatedGraphProvider,
          issues,
          preflight: options.preflight,
          progress: options.progress,
          report: options.checkIssueReport,
        });

        return {
          issues,
          passed: result.passed,
          stats: createCheckerTaskStats(result),
        };
      }
      default: {
        return assertNeverTaskName(taskName);
      }
    }
  } catch (error) {
    if (issues.length === 0) {
      if (error instanceof LiminaStructuredError) {
        issues.push(...error.issues);
      } else {
        issues.push(
          createTaskFailureIssue({
            code: `LIMINA_${taskName.replaceAll(':', '_').toUpperCase()}_FAILED`,
            detailLines: [
              error instanceof Error ? error.message : String(error),
            ],
            filePath: config.configPath,
            fix: `Inspect the ${taskName} error above, then rerun limina check.`,
            reason: `${taskName} failed: ${
              error instanceof Error ? error.message : String(error)
            }.`,
            rootDir: config.rootDir,
            task: taskName,
            title: `${taskName} failed`,
          }),
        );
      }
    }

    return {
      issues,
      passed: false,
      stats,
    };
  }
}

export function normalizePipelineStep(
  step: PipelineStep,
): NormalizedPipelineStep {
  if (typeof step !== 'string') {
    return step;
  }

  if (isBuiltinTaskName(step)) {
    return {
      name: step,
      type: 'task',
    };
  }

  const [command, ...args] = step.split(/\s+/u).filter(Boolean);

  if (!command) {
    throw new Error('Pipeline command step must not be empty.');
  }

  return {
    args,
    command,
    type: 'command',
  };
}

export function describePipeline(
  plan: ExecutionPlan,
): readonly Pick<ExecutionTask, 'id' | 'issueTask' | 'kind' | 'label'>[] {
  return plan.tasks.map(({ id, issueTask, kind, label }) => ({
    id,
    issueTask,
    kind,
    label,
  }));
}

async function runCommandStep(
  config: ResolvedLiminaConfig,
  step: Extract<PipelineStep, { type: 'command' }>,
  options: RunPipelineOptions = {},
): Promise<BuiltinTaskResult> {
  const label = getPipelineStepLabel(step);
  const task = options.progress
    ? undefined
    : options.flow?.start(`command: ${label}`, { depth: 1 });
  const commandItem = options.progress?.startItem('command execution');
  const startedAt = performance.now();
  const cwd = step.cwd
    ? path.resolve(config.rootDir, step.cwd)
    : config.rootDir;
  const commandOptions = {
    cwd,
    env: createCommandStepEnvironment(cwd, step),
    shell: shouldUseShellForCommand(step.command),
  };

  await prepareCommandStepCache(step, cwd);

  const createFailureIssue = (exitCode: number): LiminaCheckIssue =>
    createTaskFailureIssue({
      code: 'LIMINA_COMMAND_FAILED',
      evidence: [
        { label: 'command', value: step.command },
        { label: 'exit code', value: String(exitCode) },
      ],
      fix: 'Inspect the command output above, then rerun the pipeline.',
      fixSteps: [
        'Inspect the command output above this issue.',
        'Fix the failing task or command configuration.',
        `Rerun the pipeline command that includes "${label}".`,
      ],
      reason: `Pipeline command "${label}" exited with code ${exitCode}.`,
      rootDir: config.rootDir,
      task: 'command',
      title: 'Pipeline command failed',
      tool: step.command,
      verifyCommands: [step.command],
    });

  const createResult = (
    passed: boolean,
    exitCode: number,
  ): BuiltinTaskResult => {
    const durationMs = performance.now() - startedAt;

    return {
      issues: passed ? [] : [createFailureIssue(exitCode)],
      passed,
      stats: createCommandTaskStats({
        durationMs,
        passed,
      }),
    };
  };

  if (options.flow?.interactive) {
    return new Promise((resolve, reject) => {
      const child = spawn(step.command, step.args ?? [], {
        ...commandOptions,
        stdio: ['inherit', 'pipe', 'pipe'],
      });

      child.stdout?.on('data', (chunk: Uint8Array) => {
        options.flow?.writeOutput(chunk, { stream: 'stdout' });
      });
      child.stderr?.on('data', (chunk: Uint8Array) => {
        options.flow?.writeOutput(chunk, { stream: 'stderr' });
      });

      child.on('error', (error) => {
        commandItem?.fail(undefined, { error });
        task?.fail(undefined, { error });
        reject(error);
      });
      child.on('close', (code) => {
        const passed = (code ?? 1) === 0;
        const exitCode = code ?? 1;

        if (passed) {
          commandItem?.pass(undefined, {
            elapsedTimeMs: performance.now() - startedAt,
          });
          task?.pass();
        } else {
          commandItem?.fail(undefined, {
            elapsedTimeMs: performance.now() - startedAt,
          });
          task?.fail(`command failed: ${label} exited with code ${exitCode}`);
        }

        resolve(createResult(passed, exitCode));
      });
    });
  }

  const result = spawnSync(step.command, step.args ?? [], {
    ...commandOptions,
    stdio: 'inherit',
  });

  if (result.error) {
    commandItem?.fail(undefined, { error: result.error });
    task?.fail(undefined, { error: result.error });
    throw result.error;
  }

  const exitCode = result.status ?? 1;
  const passed = exitCode === 0;

  if (passed) {
    commandItem?.pass(undefined, {
      elapsedTimeMs: performance.now() - startedAt,
    });
    task?.pass();
  } else {
    commandItem?.fail(undefined, {
      elapsedTimeMs: performance.now() - startedAt,
    });
    task?.fail(`command failed: ${label} exited with code ${exitCode}`);
  }

  return createResult(passed, exitCode);
}

function getBuiltinTaskResources(taskName: BuiltinTaskName): ResourceRequest {
  const repositoryRead = ['repository:snapshot', 'workspace:manifest'];

  switch (taskName) {
    case 'graph:check': {
      return {
        read: [
          ...repositoryRead,
          'preflight:generated-graph',
          'preflight:workspace-packages',
          'preflight:importers',
        ],
      };
    }
    case 'source:check': {
      return {
        read: [
          'repository:snapshot',
          'preflight:generated-graph',
          'preflight:workspace-packages',
          'preflight:package-owners',
          'preflight:workspace-dependency-declarations',
        ],
        write: ['workspace:manifest', 'workspace:temporary-files'],
      };
    }
    case 'proof:check': {
      return {
        read: [
          ...repositoryRead,
          'preflight:generated-graph',
          'preflight:graph-project-routes',
          'preflight:checker-entry-project-routes',
          'preflight:expected-source-files',
        ],
      };
    }
    case 'checker:build': {
      return {
        read: [
          ...repositoryRead,
          'preflight:generated-graph',
          'workspace:generated-files',
        ],
        write: ['checker:build-cache'],
      };
    }
    case 'checker:typecheck': {
      return {
        read: [
          ...repositoryRead,
          'preflight:generated-graph',
          'workspace:generated-files',
        ],
        write: ['checker:typecheck-cache'],
      };
    }
    case 'package:check': {
      return {
        read: [...repositoryRead, 'package-out'],
        write: ['package-tarball'],
      };
    }
    case 'release:check': {
      return {
        read: [...repositoryRead, 'package-out'],
        write: ['release-tarball'],
      };
    }
    case 'graph:prepare': {
      return {
        read: [
          ...repositoryRead,
          'preflight:generated-graph',
          'workspace:generated-files',
        ],
      };
    }
    default: {
      return assertNeverTaskName(taskName);
    }
  }
}

function toExecutionTaskRunResult(
  result: BuiltinTaskResult,
): ExecutionTaskRunResult {
  return {
    issues: result.issues,
    sourceSnapshot: result.sourceSnapshot,
    stats: result.stats,
    status: result.passed ? 'passed' : 'failed',
  };
}

function createBuiltinExecutionTask(
  config: ResolvedLiminaConfig,
  step: Extract<NormalizedPipelineStep, { type: 'task' }>,
  generation: number,
  id: TaskId,
  options: RunPipelineOptions,
): ExecutionTask {
  return {
    failPolicy: 'continue',
    generation,
    id,
    issueTask: step.name,
    kind: 'task',
    label: getPipelineStepLabel(step),
    order: 0,
    resources: getBuiltinTaskResources(step.name),
    run: async (context) =>
      toExecutionTaskRunResult(
        await runBuiltinTask(config, step.name, {
          ...options,
          flow: context.flow,
          generatedGraphProvider: () =>
            context.preflight.ensureGeneratedGraph(),
          preflight: context.preflight,
          progress: context.progress,
          providers: context.preflight.providers,
        }),
      ),
  };
}

function createCommandExecutionTask(
  config: ResolvedLiminaConfig,
  step: Extract<NormalizedPipelineStep, { type: 'command' }>,
  generation: number,
  id: TaskId,
  options: RunPipelineOptions,
): ExecutionTask {
  return {
    failPolicy: 'stop-pipeline',
    generation,
    id,
    invalidatesPreflight: true,
    issueTask: 'command',
    kind: 'command',
    label: getPipelineStepLabel(step),
    order: 0,
    resources: {
      exclusive: ['repository:snapshot', 'workspace:manifest', 'stdout'],
    },
    run: async (context) =>
      toExecutionTaskRunResult(
        await runCommandStep(config, step, {
          ...options,
          flow: context.flow,
          preflight: context.preflight,
          progress: context.progress,
          providers: context.preflight.providers,
        }),
      ),
  };
}

const filesystemDependentTasks = new Set<BuiltinTaskName>([
  'checker:build',
  'checker:typecheck',
  'graph:prepare',
]);

function createMaterializationTask(
  generation: number,
  segment: number,
): ExecutionTask {
  return {
    failPolicy: 'continue',
    generation,
    id: taskId(`preparation:graph-materialize:g${generation}:s${segment}`),
    issueTask: 'graph:materialize',
    kind: 'preparation',
    label: 'graph:materialize',
    order: 0,
    resources: {
      read: ['repository:snapshot', 'workspace:manifest'],
      write: ['workspace:generated-files'],
    },
    run: async ({ preflight }) => {
      await preflight.ensureGeneratedArtifactsMaterialized();
      return { issues: [], status: 'passed' };
    },
  };
}

function buildExecutionPlan(
  config: ResolvedLiminaConfig,
  steps: readonly NormalizedPipelineStep[],
  options: RunPipelineOptions,
  dependencyMode: 'independent' | 'ordered',
): ExecutionPlan {
  const userTasks: ExecutionTask[] = [];
  let generation = 0;
  for (const [index, step] of steps.entries()) {
    const id = taskId(
      step.type === 'command'
        ? `step:${index}:command`
        : `step:${index}:task:${step.name}`,
    );
    const task =
      step.type === 'task'
        ? createBuiltinExecutionTask(config, step, generation, id, options)
        : createCommandExecutionTask(config, step, generation, id, options);
    if (dependencyMode === 'ordered' && userTasks.length > 0) {
      task.after = [userTasks.at(-1)!.id];
    }
    userTasks.push(task);
    if (step.type === 'command') generation += 1;
  }

  const tasks: ExecutionTask[] = [];
  generation = 0;
  let segment = 0;
  let segmentStart = 0;
  while (segmentStart < userTasks.length) {
    let segmentEnd = segmentStart;
    while (
      segmentEnd < userTasks.length &&
      userTasks[segmentEnd]!.kind !== 'command'
    ) {
      segmentEnd += 1;
    }
    const command =
      segmentEnd < userTasks.length ? userTasks[segmentEnd] : undefined;
    const segmentTasks = userTasks.slice(segmentStart, segmentEnd);
    const dependentTasks = segmentTasks.filter(
      (task) =>
        task.kind === 'task' &&
        filesystemDependentTasks.has(task.issueTask as BuiltinTaskName),
    );
    if (dependentTasks.length > 0) {
      const preparation = createMaterializationTask(generation, segment);
      const originalUserPredecessors = dependentTasks[0]?.after;
      if (originalUserPredecessors?.length) {
        preparation.after = [...originalUserPredecessors];
      }
      tasks.push(preparation);
      for (const dependent of dependentTasks) {
        dependent.requiresSuccessOf = [preparation.id];
      }
    }
    tasks.push(...segmentTasks);
    if (command) {
      tasks.push(command);
      generation += 1;
    }
    segmentStart = segmentEnd + (command ? 1 : 0);
    segment += 1;
  }

  for (const [order, task] of tasks.entries()) {
    task.order = order;
  }
  const plan = { tasks, userTaskCount: userTasks.length };
  validateExecutionPlan(plan);
  return plan;
}

export function createExecutionPlan(
  config: ResolvedLiminaConfig,
  pipelineName: string,
  options: RunPipelineOptions = {},
): ExecutionPlan {
  return buildExecutionPlan(
    config,
    getPipelineSteps(config, pipelineName).map(normalizePipelineStep),
    options,
    'ordered',
  );
}

export function createDefaultExecutionPlan(
  config: ResolvedLiminaConfig,
  options: RunPipelineOptions = {},
): ExecutionPlan {
  return buildExecutionPlan(
    config,
    defaultCheckPipeline.map(normalizePipelineStep),
    options,
    'independent',
  );
}

export function describeDefaultCheckPipeline(
  plan: ExecutionPlan,
): ReturnType<typeof describePipeline> {
  return describePipeline(plan);
}

function reportPostCommitProjectionWarning(error: unknown): void {
  try {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `limina warning: parent flow completion projection failed: ${message}\n`,
    );
  } catch {
    // Post-commit diagnostics must never alter committed execution.
  }
}

function projectParentFlowCompletion(options: {
  blockedMessage: string;
  failedMessage: string;
  outcome: CompletedRunOutcome;
  passedMessage?: string;
  task: LiminaFlowTask | undefined;
}): void {
  try {
    if (options.outcome.state === 'passed') {
      options.task?.pass(options.passedMessage);
    } else if (options.outcome.state === 'blocked') {
      options.task?.fail(
        `${options.blockedMessage}${
          options.outcome.blocker ? ` at ${options.outcome.blocker.label}` : ''
        }`,
      );
    } else {
      options.task?.fail(options.failedMessage);
    }
  } catch (error) {
    reportPostCommitProjectionWarning(error);
  }
}

export async function runPipeline(
  config: ResolvedLiminaConfig,
  pipelineName: string,
  options: RunPipelineOptions = {},
): Promise<boolean> {
  const plan =
    options.executionPlan ?? createExecutionPlan(config, pipelineName, options);
  const pipelineTask = options.flow?.start(`pipeline: ${pipelineName}`, {
    collapseOnSuccess: false,
  });
  const preflight =
    options.preflight ??
    new LiminaPreflightManager({
      config,
      providers: options.providers,
      generatedGraphProvider: options.generatedGraphProvider,
    });
  const execution = await runExecutionPlan(plan, {
    checkRunRecorder: options.checkRunRecorder,
    command:
      options.checkIssueReport?.command ?? `limina check ${pipelineName}`,
    flow: options.flow,
    preflight,
    rootDir: config.rootDir,
  });

  projectParentFlowCompletion({
    blockedMessage: `pipeline blocked: ${pipelineName}`,
    failedMessage: `pipeline finished with failures: ${pipelineName}`,
    outcome: execution.outcome,
    task: pipelineTask,
  });

  return execution.passed;
}

export async function runDefaultCheck(
  config: ResolvedLiminaConfig,
  options: RunPipelineOptions = {},
): Promise<boolean> {
  const plan =
    options.executionPlan ?? createDefaultExecutionPlan(config, options);
  const pipelineTask = options.flow?.start('default check', {
    collapseOnSuccess: false,
  });
  const preflight =
    options.preflight ??
    new LiminaPreflightManager({
      config,
      providers: options.providers,
      generatedGraphProvider: options.generatedGraphProvider,
    });
  const shouldReportAutoCheckerCapabilities = usesAutoCheckers(config);

  if (!shouldReportAutoCheckerCapabilities) {
    reportCheckerCapabilities(config, options.flow);
  }

  const execution = await runExecutionPlan(plan, {
    checkRunRecorder: options.checkRunRecorder,
    command: options.checkIssueReport?.command ?? 'limina check',
    flow: options.flow,
    preflight,
    rootDir: config.rootDir,
  });

  if (shouldReportAutoCheckerCapabilities) {
    try {
      await reportAutoCheckerCapabilities(config, options.flow, preflight);
    } catch (error) {
      reportPostCommitProjectionWarning(error);
    }
  }

  projectParentFlowCompletion({
    blockedMessage: 'default check blocked',
    failedMessage: 'default check finished with failures',
    outcome: execution.outcome,
    task: pipelineTask,
  });

  return execution.passed;
}
