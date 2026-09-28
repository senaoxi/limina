import type { LiminaFlowTreeNode } from '../flow';
import type { createPreflightGenerationController } from '../preflight/generation';
import type {
  RunExecutionPlanOptions,
  RunningTaskEntry,
} from './executor-types';
import type { ResourceLockSet } from './resources';
import type { ExecutionStateStore } from './state-store';
import type { ExecutionTask, ExecutionTaskOutcome, TaskId } from './tasks';

export interface SchedulerContext {
  concurrency: number;
  controller: ReturnType<typeof createPreflightGenerationController>;
  flowNodes: Map<TaskId, LiminaFlowTreeNode>;
  infrastructureError: unknown;
  locks: ResourceLockSet;
  options: RunExecutionPlanOptions;
  orderedTasks: ExecutionTask[];
  outcomes: Map<TaskId, ExecutionTaskOutcome>;
  pending: Map<TaskId, ExecutionTask>;
  pendingGenerationAdvance: boolean;
  running: Map<TaskId, RunningTaskEntry>;
  state: ExecutionStateStore;
}
