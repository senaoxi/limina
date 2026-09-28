import type {
  CheckRunRecorder,
  LiminaCheckRunTaskStats,
} from '../check-reporting/run-recorder';
import type {
  CheckIssueSnapshot,
  LiminaCheckIssue,
  SourceIssueSnapshot,
} from '../check-reporting/snapshot';
import type { LiminaArtifactNamespace } from '../domain/artifacts/namespace';
import type { LiminaFlowReporter, LiminaFlowTreeNode } from '../flow';
import type { LiminaPreflightManager } from '../preflight';
import type { ResourceRequest } from './resources';
import type {
  CompletedRunOutcome,
  ExecutionTask,
  ExecutionTaskOutcome,
  StartedTaskResult,
  TaskId,
} from './tasks';

export interface RunExecutionPlanOptions {
  checkRunRecorder?: CheckRunRecorder;
  command: string;
  flow?: LiminaFlowReporter;
  onTaskStats?: (
    task: ExecutionTask,
    stats: LiminaCheckRunTaskStats | undefined,
  ) => void;
  preflight: LiminaPreflightManager;
  rootDir: string;
  snapshotWriters?: {
    writeCheck(
      namespace: LiminaArtifactNamespace,
      snapshot: CheckIssueSnapshot,
    ): Promise<void>;
    writeSource(
      namespace: LiminaArtifactNamespace,
      snapshot: SourceIssueSnapshot,
    ): Promise<void>;
  };
}

export interface RunExecutionTasksOptions extends RunExecutionPlanOptions {
  tasks: readonly ExecutionTask[];
}

export interface ExecutionTaskResultView {
  durationMs?: number;
  id: TaskId;
  issues: readonly LiminaCheckIssue[];
  label: string;
  passed: boolean;
  status: ExecutionTaskOutcome['status'];
}

export interface RunExecutionResult {
  issues: LiminaCheckIssue[];
  outcome: CompletedRunOutcome;
  passed: boolean;
  results: ExecutionTaskResultView[];
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

export type StartDecision = { type: 'run' } | { error: unknown; type: 'abort' };

export type RunningTaskSettlement =
  | { outcome: StartedTaskResult; type: 'task' }
  | { error: unknown; type: 'infrastructure-start-failure' };

export interface RunningTaskEntry {
  executionStarted: boolean;
  gate: Deferred<StartDecision>;
  locks: ResourceRequest;
  settlement: Promise<RunningTaskSettlement>;
  task: ExecutionTask;
}

export interface ExecutionFlowNodes {
  get(taskId: TaskId): LiminaFlowTreeNode | undefined;
}
