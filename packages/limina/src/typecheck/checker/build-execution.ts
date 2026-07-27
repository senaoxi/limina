import type { ResolvedCheckerConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type { ValidatedWorkspaceContext } from '../../core/workspace/validated-context';
import type { TaskProgressItem } from '../../execution/progress';
import type { LiminaFlowTask } from '../../flow';
import { TypecheckLogger } from '../../logger';
import type { LiminaPreflightManager } from '../../preflight';
import { runBuildTargets } from '../build/plan';
import { ManagedCheckerMutationCoordinator } from '../managed/coordinator';
import {
  collectFailedCheckerTargets,
  completeCheckerTargetTask,
  createPlannedCheckerTargetTasks,
  formatFailedTargetSummaryReport,
  getCheckerTargetFlowLabel,
  resolveTypecheckRunner,
  shouldLogCheckReport,
} from '../runner-shared';
import type {
  CheckerFailureTarget,
  RunCheckerBuildOptions,
} from '../runner-types';
import {
  type CheckerTargetId,
  type CheckerTargetOutcome,
  toCheckerTargetOutcome,
  type TypecheckTarget,
  type TypecheckTargetResult,
} from '../targets';

type CheckerFlowTask = LiminaFlowTask | TaskProgressItem;

export interface CheckerBuildExecutionResult {
  failedResults: TypecheckTargetResult[];
  failedTargets: CheckerFailureTarget[];
  passed: boolean;
  results: TypecheckTargetResult[];
  targetOutcomes: CheckerTargetOutcome[];
}

function startProgressTarget(options: {
  target: TypecheckTarget;
  tasks: ReadonlyMap<CheckerTargetId, CheckerFlowTask>;
}): void {
  const task = options.tasks.get(options.target.id);
  if (task !== undefined) (task as TaskProgressItem).start();
}

function startFlowTarget(options: {
  flowDepth: number;
  label: string;
  runnerOptions: RunCheckerBuildOptions;
  target: TypecheckTarget;
  tasks: Map<CheckerTargetId, CheckerFlowTask>;
  projectRootDir: string;
}): void {
  const flow = options.runnerOptions.flow;
  if (flow === undefined) return;
  options.tasks.set(
    options.target.id,
    flow.start(
      getCheckerTargetFlowLabel({
        prefix: options.label,
        projectRootDir: options.projectRootDir,
        target: options.target,
      }),
      {
        collapseOnSuccess: false,
        depth: options.flowDepth + 1,
      },
    ),
  );
}

function startTarget(options: {
  flowDepth: number;
  label: string;
  projectRootDir: string;
  runnerOptions: RunCheckerBuildOptions;
  target: TypecheckTarget;
  tasks: Map<CheckerTargetId, CheckerFlowTask>;
}): void {
  if (options.runnerOptions.progress !== undefined) {
    startProgressTarget(options);
    return;
  }
  startFlowTarget(options);
}

function completeTarget(options: {
  result: TypecheckTargetResult;
  target: TypecheckTarget;
  tasks: ReadonlyMap<CheckerTargetId, CheckerFlowTask>;
}): void {
  const task = options.tasks.get(options.target.id);
  if (task !== undefined) completeCheckerTargetTask(task, options.result);
}

function createTargetOutcomes(options: {
  results: readonly TypecheckTargetResult[];
  targets: readonly TypecheckTarget[];
}): CheckerTargetOutcome[] {
  const targetsById = new Map(
    options.targets.map((target) => [target.id, target]),
  );
  return options.results.flatMap((result) => {
    const target = targetsById.get(result.id);
    return target === undefined ? [] : [toCheckerTargetOutcome(target, result)];
  });
}

export async function executeCheckerBuildTargets(options: {
  allCheckers: readonly ResolvedCheckerConfig[];
  config: RunCheckerBuildOptions['config'];
  flowDepth: number;
  generatedGraph: GeneratedTsconfigGraphResult;
  label: string;
  preflight: LiminaPreflightManager;
  projectRootDir: string;
  runnerOptions: RunCheckerBuildOptions;
  targets: readonly TypecheckTarget[];
  watch: boolean | undefined;
  workspaceContext: ValidatedWorkspaceContext;
}): Promise<CheckerBuildExecutionResult> {
  const tasks: Map<CheckerTargetId, CheckerFlowTask> = new Map(
    createPlannedCheckerTargetTasks({
      prefix: options.label,
      progress: options.runnerOptions.progress,
      projectRootDir: options.projectRootDir,
      targets: options.targets,
    }),
  );
  const mutationCoordinator = await ManagedCheckerMutationCoordinator.create({
    artifactNamespace: options.preflight.artifactNamespace,
    checkers: options.allCheckers,
    config: options.config,
    generatedGraph: options.generatedGraph,
    targets: options.targets,
    workspaceContext: options.workspaceContext,
  });
  const results = await runBuildTargets(
    [...options.targets],
    options.generatedGraph.providerEdges,
    resolveTypecheckRunner(options.runnerOptions),
    {
      beforeLayerRun: (targets) => mutationCoordinator.beforeLayerRun(targets),
      beforeTargetRun: (target) => mutationCoordinator.beforeTargetRun(target),
      config: options.config,
      onTargetResult: (target, result) =>
        completeTarget({ result, target, tasks }),
      onTargetStart: (target) => startTarget({ ...options, target, tasks }),
      watch: options.watch,
    },
  );
  const failedResults = results.filter((result) => result.status !== 0);
  return {
    failedResults,
    failedTargets: collectFailedCheckerTargets(options.targets, failedResults),
    passed: failedResults.length === 0,
    results,
    targetOutcomes: createTargetOutcomes({ results, targets: options.targets }),
  };
}

function reportCheckerBuildFailure(options: {
  execution: CheckerBuildExecutionResult;
  projectRootDir: string;
  report: RunCheckerBuildOptions['report'];
}): boolean {
  if (options.execution.passed) return false;
  if (!shouldLogCheckReport(options.report)) return true;
  TypecheckLogger.error(
    formatFailedTargetSummaryReport({
      failedResults: options.execution.failedResults,
      heading: 'build checks failed:',
      pluralIssueLabel: 'failed checker build targets',
      projectRootDir: options.projectRootDir,
      singularIssueLabel: 'failed checker build target',
      title: 'Checker build summary',
    }),
  );
  return true;
}

function shouldReportCheckerBuildSuccess(options: {
  report: RunCheckerBuildOptions['report'];
  runnerOptions: RunCheckerBuildOptions;
}): boolean {
  if (!shouldLogCheckReport(options.report)) return false;
  return options.runnerOptions.flow?.interactive !== true;
}

export function reportCheckerBuildExecution(options: {
  execution: CheckerBuildExecutionResult;
  projectRootDir: string;
  report: RunCheckerBuildOptions['report'];
  runnerOptions: RunCheckerBuildOptions;
  successLabel: 'entry' | 'target';
  targetCount: number;
}): void {
  if (reportCheckerBuildFailure(options)) return;
  if (!shouldReportCheckerBuildSuccess(options)) return;
  TypecheckLogger.success(
    `Checked ${options.targetCount} checker build ${options.successLabel}(s).`,
  );
}
