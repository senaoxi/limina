import type { ResolvedCheckerConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type { ValidatedWorkspaceContext } from '../../core/workspace/validated-context';
import type { TaskProgressItem } from '../../execution/progress';
import type { LiminaFlowTask } from '../../flow';
import { TypecheckLogger } from '../../logger';
import type { LiminaPreflightManager } from '../../preflight';
import { ExecutionAdmission } from '../admission/execution-admission';
import { proveExecutionPrerequisites } from '../admission/execution-prerequisites';
import {
  admissionFailureTargets,
  executionFailureKind,
} from '../admission/reporting';
import { runBuildTargets } from '../build/target-execution';
import { copySuccessfulBuildTarget } from '../managed-build-copy';
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
  CheckerBuildExecutionResult,
  RunCheckerBuildOptions,
} from '../runner-types';
import {
  type CheckerTargetId,
  type CheckerTargetOutcome,
  toCheckerTargetOutcome,
  type TypecheckTarget,
  type TypecheckTargetResult,
} from '../targets';
import { executeAuthorizedBuild } from './managed-execution';
type CheckerFlowTask = LiminaFlowTask | TaskProgressItem;
export type { CheckerBuildExecutionResult } from '../runner-types';
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
  const admission = new ExecutionAdmission(
    options.preflight,
    options.generatedGraph,
    options.targets,
  );
  const runner = resolveTypecheckRunner(options.runnerOptions);
  const deliveries = new Map<
    CheckerTargetId,
    Awaited<ReturnType<typeof copySuccessfulBuildTarget>>
  >();
  const prerequisites = await proveExecutionPrerequisites(options, admission);
  const completions = await runBuildTargets(
    [...options.targets],
    options.generatedGraph.dependencyEdges,
    runner,
    {
      executionPrerequisites: prerequisites.dependencies,
      isDeliveryComplete: (id) => {
        const delivery = deliveries.get(id);
        return (
          delivery === undefined ||
          (delivery.state === 'executed' && delivery.value === null)
        );
      },
      executeTarget: async (target) => {
        const result = await executeAuthorizedBuild(
          { ...options, preparation: prerequisites.preparations.get(target) },
          admission,
          target,
        );
        if (result.status === 0 && options.watch !== true)
          deliveries.set(
            target.id,
            await copySuccessfulBuildTarget(
              {
                admission,
                preflight: options.preflight,
                request: options.runnerOptions,
                projectRootDir: options.projectRootDir,
                flowDepth: options.flowDepth,
              },
              target,
            ),
          );
        return result;
      },
      config: options.config,
      onTargetResult: (target, result) =>
        completeTarget({ result, target, tasks }),
      onTargetOutcome: (target, result) => {
        if (typeof result.status !== 'number') tasks.get(target.id)?.fail();
      },
      onTargetStart: (target) => startTarget({ ...options, target, tasks }),
      watch: options.watch,
    },
  );
  return summarizeBuildExecution({
    admission,
    targets: options.targets,
    completions,
    deliveries,
  });
}
function summarizeBuildExecution(input: {
  admission: ExecutionAdmission;
  targets: readonly TypecheckTarget[];
  completions: Awaited<ReturnType<typeof runBuildTargets>>;
  deliveries: ReadonlyMap<
    CheckerTargetId,
    Awaited<ReturnType<typeof copySuccessfulBuildTarget>>
  >;
}): CheckerBuildExecutionResult {
  const { completions, deliveries, admission } = input;
  const results = completions.filter(
    (result): result is TypecheckTargetResult =>
      typeof result.status === 'number',
  );
  const refused = completions.filter(
    (result) => typeof result.status !== 'number',
  );
  const copyRefusals = deliveries
    .values()
    .flatMap((copy) => (copy.state === 'refused' ? [copy.rejection] : []))
    .toArray();
  refused.push(...copyRefusals);
  const copyErrors = [...deliveries].flatMap(([id, copy]) =>
    copy.state === 'executed' && copy.value !== null
      ? [
          {
            id,
            configPath: input.targets.find((target) => target.id === id)!
              .configPath,
            message: copy.value,
          },
        ]
      : [],
  );
  const failedResults = results.filter((result) => result.status !== 0);
  return {
    admission,
    failureKind: executionFailureKind(failedResults, [
      ...refused,
      ...copyErrors,
    ]),
    failedResults,
    failedTargets: [
      ...collectFailedCheckerTargets(input.targets, failedResults),
      ...copyErrors,
      ...admissionFailureTargets(input.targets, refused),
    ],
    passed:
      failedResults.length === 0 &&
      refused.length === 0 &&
      copyErrors.length === 0,
    results,
    targetOutcomes: [
      ...createTargetOutcomes({ results, targets: input.targets }),
      ...refused,
    ],
  };
}
function isReportCheckerBuildFailure(options: {
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
  return (
    shouldLogCheckReport(options.report) &&
    options.runnerOptions.flow?.interactive !== true
  );
}
export function reportCheckerBuildExecution(options: {
  execution: CheckerBuildExecutionResult;
  projectRootDir: string;
  report: RunCheckerBuildOptions['report'];
  runnerOptions: RunCheckerBuildOptions;
  successLabel: 'entry' | 'target';
  targetCount: number;
}): void {
  if (
    isReportCheckerBuildFailure(options) ||
    !shouldReportCheckerBuildSuccess(options)
  )
    return;
  TypecheckLogger.success(
    `Checked ${options.targetCount} checker build ${options.successLabel}(s).`,
  );
}
