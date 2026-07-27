import { createPreflightGenerationController } from '../preflight/generation';
import { runExecutionPlanWithController } from './executor-run';
import type {
  RunExecutionPlanOptions,
  RunExecutionResult,
  RunExecutionTasksOptions,
} from './executor-types';
import type { ExecutionPlan } from './tasks';

export {
  createCompletedRunOutcome,
  resolveRootBlocker,
} from './execution-results';
export type * from './executor-types';
export { validateExecutionPlan } from './plan-validation';

export function runExecutionPlan(
  plan: ExecutionPlan,
  options: RunExecutionPlanOptions,
): Promise<RunExecutionResult> {
  const controller = createPreflightGenerationController(options.preflight);
  return runExecutionPlanWithController(plan, options, controller);
}

export function runExecutionTasks(
  options: RunExecutionTasksOptions,
): ReturnType<typeof runExecutionPlan> {
  return runExecutionPlan(
    { tasks: options.tasks, userTaskCount: options.tasks.length },
    options,
  );
}
