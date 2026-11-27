import type { ResolvedCheckerConfig } from '#config/runner';
import type { PreparedTsconfigGraph } from '#core/build-graph/runner';
import type { ValidatedWorkspaceContext } from '../../core/workspace/validated-context';
import { measureTaskProgress } from '../../execution/progress';
import { TypecheckLogger } from '../../logger';
import type { LiminaPreflightManager } from '../../preflight';
import { acquireCrossProcessWriteLease } from '../../utils/mutation/cross-process-lease';
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
  createCheckerTargetFlow,
  formatFailedTargetSummaryReport,
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
export type { CheckerBuildExecutionResult } from '../runner-types';
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
interface CheckerBuildExecutionOptions {
  allCheckers: readonly ResolvedCheckerConfig[];
  config: RunCheckerBuildOptions['config'];
  flowDepth: number;
  generatedGraph: PreparedTsconfigGraph;
  label: string;
  preflight: LiminaPreflightManager;
  projectRootDir: string;
  runnerOptions: RunCheckerBuildOptions;
  targets: readonly TypecheckTarget[];
  watch: boolean | undefined;
  workspaceContext: ValidatedWorkspaceContext;
}

const CHECKER_BUILD_LEASE = {
  leaseName: 'checker-build',
  timeoutMs: 10 * 60_000,
};

export async function executeCheckerBuildTargets(
  options: CheckerBuildExecutionOptions,
): Promise<CheckerBuildExecutionResult> {
  if (options.watch === true || options.targets.length === 0)
    return executeBuildTargets(options);

  // Prerequisite proofs also scan compiler outputs. Keep the lease through
  // both admission and declaration delivery.
  const lease = await acquireCrossProcessWriteLease(
    options.preflight.artifactNamespace.canonicalRootDir,
    CHECKER_BUILD_LEASE,
  );
  try {
    return await executeBuildTargets(options);
  } finally {
    await lease.release();
  }
}

async function executeBuildTargets(
  options: CheckerBuildExecutionOptions,
): Promise<CheckerBuildExecutionResult> {
  const admission = new ExecutionAdmission(
    options.preflight,
    options.generatedGraph,
    options.targets,
  );
  const runner = resolveTypecheckRunner(options.runnerOptions);
  const prerequisites =
    options.targets.length === 0
      ? await proveExecutionPrerequisites(options, admission)
      : await measureTaskProgress(
          options.runnerOptions.progress,
          'check build prerequisites',
          () => proveExecutionPrerequisites(options, admission),
        );
  const taskFlow = createCheckerTargetFlow({
    flow: options.runnerOptions.flow,
    flowDepth: options.flowDepth,
    prefix: options.label,
    progress: options.runnerOptions.progress,
    projectRootDir: options.projectRootDir,
    targets: options.targets,
  });
  const deliveries = new Map<
    CheckerTargetId,
    Awaited<ReturnType<typeof copySuccessfulBuildTarget>>
  >();
  const isDeliveryComplete = (id: CheckerTargetId): boolean => {
    const delivery = deliveries.get(id);
    return delivery === undefined || isDeclarationDeliveryComplete(delivery);
  };
  const completions = await runBuildTargets(
    [...options.targets],
    options.generatedGraph.dependencyEdges,
    runner,
    {
      executionPrerequisites: prerequisites.dependencies,
      isDeliveryComplete,
      executeTarget: async (target) => {
        const progress = taskFlow.progress(target);
        const result = await executeAuthorizedBuild(
          {
            ...options,
            preparation: prerequisites.preparations.get(target),
            progress,
          },
          admission,
          target,
        );
        if (result.status === 0 && options.watch !== true)
          deliveries.set(
            target.id,
            await measureTaskProgress(
              progress,
              'publish build declarations',
              () =>
                copySuccessfulBuildTarget(
                  {
                    admission,
                    preflight: options.preflight,
                    request: options.runnerOptions,
                    projectRootDir: options.projectRootDir,
                    flowDepth: options.flowDepth,
                  },
                  target,
                ),
              isDeclarationDeliveryComplete,
            ),
          );
        return result;
      },
      config: options.config,
      onTargetOutcome: (target, result) =>
        taskFlow.complete(target, result, !isDeliveryComplete(target.id)),
      onTargetStart: taskFlow.start,
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
function isDeclarationDeliveryComplete(
  delivery: Awaited<ReturnType<typeof copySuccessfulBuildTarget>>,
): boolean {
  return delivery.state === 'executed' && delivery.value === null;
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
