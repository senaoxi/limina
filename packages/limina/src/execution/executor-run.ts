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

export async function runExecutionPlanWithController(
  plan: ExecutionPlan,
  options: RunExecutionPlanOptions,
  controller: SchedulerContext['controller'],
): Promise<RunExecutionResult> {
  validateExecutionPlan(plan);
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
  await writeSnapshotsPreservingFailure({
    completedState: completedOutcome.state,
    execution: options,
    finalRepositoryGeneration: context.controller.generation,
    issues,
    sourceOutcome: source.sourceOutcome,
    sourceTask: source.sourceTask,
    tasks: context.orderedTasks,
  });
  return createExecutionResult({
    issues,
    orderedTasks: context.orderedTasks,
    outcome: completedOutcome,
    outcomes: context.outcomes,
  });
}
