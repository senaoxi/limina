import type { LiminaCheckRunTaskStats } from '../check-reporting/run-recorder';
import type {
  LiminaCheckIssue,
  LiminaCheckTaskName,
} from '../check-reporting/snapshot';
import type { LiminaFlowReporter } from '../flow';
import type { LiminaPreflightManager } from '../preflight';
import type { SourceCheckIssue } from '../source-check/report';
import type { TaskProgressReporter } from './progress';
import type { ResourceRequest } from './resources';

declare const taskIdBrand: unique symbol;

export type TaskId = string & { readonly [taskIdBrand]: 'TaskId' };

export function taskId(value: string): TaskId {
  if (value.length === 0) {
    throw new Error('Execution task id must not be empty.');
  }

  return value as TaskId;
}

export type ExecutionTaskKind = 'command' | 'preparation' | 'task';
export type TaskLifecycleState =
  | 'planned'
  | 'running'
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'skipped';
export type RunLifecycleState =
  | 'not-run'
  | 'running'
  | 'passed'
  | 'failed'
  | 'blocked';

export interface ExecutionTaskIdentity {
  generation: number;
  id: TaskId;
  issueTask: LiminaCheckTaskName;
  kind: ExecutionTaskKind;
  label: string;
}

export interface TaskReference {
  id: TaskId;
  label: string;
}

export interface AuthoritativeSourceSnapshotPayload {
  issues: readonly SourceCheckIssue[];
  status: 'completed';
}

export interface ExecutionTaskRunResult {
  issues: readonly LiminaCheckIssue[];
  sourceSnapshot?: AuthoritativeSourceSnapshotPayload;
  stats?: LiminaCheckRunTaskStats;
  status: 'failed' | 'passed';
}

export interface StartedTaskResult extends ExecutionTaskRunResult {
  durationMs: number;
}

export type ExecutionTaskOutcome =
  | StartedTaskResult
  | { blockedBy: TaskReference; status: 'blocked' }
  | { causedBy: TaskReference; reason: string; status: 'skipped' };

export interface CompletedRunOutcome {
  blocker?: TaskReference;
  state: 'blocked' | 'failed' | 'passed';
}

export type TaskLifecycleEvent =
  | { startedAt: string; type: 'start' }
  | {
      completedAt: string;
      durationMs: number;
      stats?: LiminaCheckRunTaskStats;
      type: 'pass';
    }
  | {
      completedAt: string;
      durationMs: number;
      reason?: string;
      stats?: LiminaCheckRunTaskStats;
      type: 'fail';
    }
  | { blockedBy: TaskReference; type: 'block' }
  | { reason: string; type: 'skip' };

export interface ExecutionTaskRunContext {
  flow?: LiminaFlowReporter;
  preflight: LiminaPreflightManager;
  progress?: TaskProgressReporter;
}

export interface ExecutionTask extends ExecutionTaskIdentity {
  after?: readonly TaskId[];
  failPolicy: 'continue' | 'stop-pipeline';
  invalidatesPreflight?: boolean;
  order: number;
  requiresSuccessOf?: readonly TaskId[];
  resources: ResourceRequest;
  run: (context: ExecutionTaskRunContext) => Promise<ExecutionTaskRunResult>;
}

export interface ExecutionPlan {
  tasks: readonly ExecutionTask[];
  userTaskCount: number;
}

export function taskReference(task: ExecutionTaskIdentity): TaskReference {
  return { id: task.id, label: task.label };
}
