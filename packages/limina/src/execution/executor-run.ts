import {
  abortCheckAttempt,
  publishCheckAttempt,
} from '../source-check/snapshot/check-attempt-io';
import {
  collectExecutionIssues,
  createCompletedRunOutcome,
  createExecutionResult,
  selectSourceOutcome,
} from './execution-results';
import { writeSnapshotsPreservingFailure } from './execution-snapshots';
import type {
  RunExecutionPlanOptions,
  RunExecutionResult,
} from './executor-types';
import { validateExecutionPlan } from './plan-validation';
import { createSchedulerContext } from './scheduler-context';
import { runScheduler } from './scheduler-loop';
import type { SchedulerContext } from './scheduler-types';
import type { ExecutionPlan } from './tasks';

function ignoreError(error: unknown): void {
  String(error);
}

export async function runExecutionPlanWithController(
  plan: ExecutionPlan,
  options: RunExecutionPlanOptions,
  controller: SchedulerContext['controller'],
): Promise<RunExecutionResult> {
  validateExecutionPlan(plan);
  const attempt = await publishCheckAttempt({
    command: options.command,
    namespace: options.preflight.artifactNamespace,
  });
  const execution = await (async () => {
    const context = createSchedulerContext(plan, options, controller);
    await runScheduler(context);
    const completedOutcome = createCompletedRunOutcome(
      context.orderedTasks,
      context.outcomes,
    );
    context.state.finish(completedOutcome);
    options.checkRunRecorder?.finish(completedOutcome);
    const issues = collectExecutionIssues({
      orderedTasks: context.orderedTasks,
      outcomes: context.outcomes,
      rootDir: options.rootDir,
    });
    const source = selectSourceOutcome({
      orderedTasks: context.orderedTasks,
      outcomes: context.outcomes,
    });
    return { completedOutcome, context, issues, source };
  })().catch(async (error: unknown) => {
    await abortCheckAttempt({
      attempt,
      error,
      namespace: options.preflight.artifactNamespace,
    }).catch(ignoreError);
    throw error;
  });
  await writeSnapshotsPreservingFailure({
    attempt,
    completedState: execution.completedOutcome.state,
    execution: options,
    finalRepositoryGeneration: execution.context.controller.generation,
    issues: execution.issues,
    sourceOutcome: execution.source.sourceOutcome,
    sourceTask: execution.source.sourceTask,
    tasks: execution.context.orderedTasks,
  });
  return createExecutionResult({
    issues: execution.issues,
    orderedTasks: execution.context.orderedTasks,
    outcome: execution.completedOutcome,
    outcomes: execution.context.outcomes,
  });
}
