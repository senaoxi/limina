import { resolveRootBlocker } from './execution-results';
import type { SchedulerContext } from './scheduler-types';
import type { ExecutionTask, TaskId } from './tasks';

function getRequiredDependencies(task: ExecutionTask): readonly TaskId[] {
  return task.requiresSuccessOf ?? [];
}

function getAllDependencies(task: ExecutionTask): Set<TaskId> {
  return new Set([...(task.after ?? []), ...getRequiredDependencies(task)]);
}

export function dependenciesSettled(
  task: ExecutionTask,
  context: SchedulerContext,
): boolean {
  return [...getAllDependencies(task)].every((id) => context.outcomes.has(id));
}

type RootBlocker = ReturnType<typeof resolveRootBlocker>;
const missingBlocker = new Map<string, RootBlocker>().get('missing');

function getDependencyBlocker(options: {
  context: SchedulerContext;
  dependencyTask: ExecutionTask;
}): RootBlocker {
  const outcome = options.context.outcomes.get(options.dependencyTask.id);
  if (outcome === undefined) return missingBlocker;
  return resolveRootBlocker(options.dependencyTask, outcome);
}

function isRequiredDependency(options: {
  required: readonly TaskId[];
  task: ExecutionTask;
}): boolean {
  return options.required.includes(options.task.id);
}

export function findBlockedDependency(options: {
  context: SchedulerContext;
  task: ExecutionTask;
}): RootBlocker {
  const required = getRequiredDependencies(options.task);
  const blockers = options.context.orderedTasks
    .filter((task) => isRequiredDependency({ required, task }))
    .map((dependencyTask) =>
      getDependencyBlocker({ context: options.context, dependencyTask }),
    );
  return blockers.find((blocker) => blocker !== undefined);
}

export function canStartTask(options: {
  context: SchedulerContext;
  task: ExecutionTask;
}): boolean {
  if (options.context.running.size >= options.context.concurrency) return false;
  return options.context.locks.canAcquire(options.task.resources);
}
