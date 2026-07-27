import { resolveTaskConcurrency } from './config';
import type { RunExecutionPlanOptions } from './executor-types';
import { ResourceLockSet } from './resources';
import type { SchedulerContext } from './scheduler-types';
import { ExecutionStateStore } from './state-store';
import { formatFlowTaskName } from './task-observers';
import type { ExecutionPlan, ExecutionTask } from './tasks';

function resolveConcurrency(options: {
  execution: RunExecutionPlanOptions;
  taskCount: number;
}): number {
  return Math.max(
    1,
    resolveTaskConcurrency({
      config: options.execution.preflight.config,
      itemCount: options.taskCount,
    }),
  );
}

function createFlowNodes(options: {
  execution: RunExecutionPlanOptions;
  tasks: readonly ExecutionTask[];
}) {
  const nodes: SchedulerContext['flowNodes'] = new Map();
  if (options.execution.flow === undefined) return nodes;
  for (const task of options.tasks) {
    nodes.set(
      task.id,
      options.execution.flow.tree(formatFlowTaskName(task), { depth: 1 }),
    );
  }
  return nodes;
}

export function createSchedulerContext(
  plan: ExecutionPlan,
  execution: RunExecutionPlanOptions,
  controller: SchedulerContext['controller'],
): SchedulerContext {
  const orderedTasks = [...plan.tasks].sort(
    (left, right) => left.order - right.order,
  );
  return {
    concurrency: resolveConcurrency({
      execution,
      taskCount: orderedTasks.length,
    }),
    controller,
    flowNodes: createFlowNodes({ execution, tasks: orderedTasks }),
    infrastructureError: undefined,
    locks: new ResourceLockSet(),
    options: execution,
    orderedTasks,
    outcomes: new Map(),
    pending: new Map(orderedTasks.map((task) => [task.id, task])),
    pendingGenerationAdvance: false,
    running: new Map(),
    state: new ExecutionStateStore(orderedTasks),
  };
}
