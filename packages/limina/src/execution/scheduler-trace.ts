import { ResourceLockSet } from './resources';
import type { SchedulerContext } from './scheduler-types';
import { type ExecutionTask, getTaskDependencies, type TaskId } from './tasks';

function resourceBlockers(
  task: ExecutionTask,
  context: SchedulerContext,
): TaskId[] {
  return context.running
    .values()
    .flatMap((entry) => {
      const lock = new ResourceLockSet();
      lock.acquire(entry.task.id, entry.locks);
      return lock.canAcquire(task.resources) ? [] : [entry.task.id];
    })
    .toArray();
}

export function observeScheduler(context: SchedulerContext): void {
  const trace = context.options.checkRunRecorder?.trace;
  if (trace === undefined) return;
  for (const task of context.pending.values()) {
    if (task.generation > context.controller.generation) {
      trace.observe(task.id, {
        reason: 'generation',
        blockers: context.orderedTasks
          .filter(
            (candidate) =>
              candidate.generation < task.generation &&
              !context.outcomes.has(candidate.id),
          )
          .map((candidate) => candidate.id),
      });
      continue;
    }
    const dependencies = [...getTaskDependencies(task)].filter(
      (id) => !context.outcomes.has(id),
    );
    if (dependencies.length > 0) {
      trace.observe(task.id, { reason: 'dependency', blockers: dependencies });
      continue;
    }
    if (context.running.size >= context.concurrency) {
      trace.observe(task.id, {
        reason: 'capacity',
        blockers: context.running.keys().toArray(),
      });
      continue;
    }
    const blockers = resourceBlockers(task, context);
    trace.observe(
      task.id,
      blockers.length > 0
        ? {
            reason: 'resource',
            blockers,
            resources: [
              ...(task.resources.exclusive ?? []),
              ...(task.resources.read ?? []),
              ...(task.resources.write ?? []),
            ],
          }
        : { reason: 'scheduling', blockers: [] },
    );
  }
}
