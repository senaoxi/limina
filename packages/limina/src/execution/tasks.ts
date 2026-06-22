import type { LiminaCheckRunTaskStats } from '../check-reporting/run-recorder';
import type {
  LiminaCheckIssue,
  LiminaCheckRunTaskKind,
} from '../check-reporting/snapshot';
import type { SourceCheckIssue } from '../source-check/report';
import type { TaskProgressReporter } from './progress';
import type { ResourceRequest } from './resources';

export type ExecutionTaskStatus = 'blocked' | 'failed' | 'passed' | 'skipped';

export type ExecutionTaskFailPolicy = 'block-remaining' | 'continue';

export interface ExecutionTaskResult {
  durationMs: number;
  id: string;
  invalidatesPreflight?: boolean;
  issues: readonly LiminaCheckIssue[];
  name: string;
  passed: boolean;
  sourceIssues?: readonly SourceCheckIssue[];
  sourceLegacyProblems?: readonly string[];
  stats?: LiminaCheckRunTaskStats;
  status: ExecutionTaskStatus;
}

export interface ExecutionTaskRunContext {
  progress?: TaskProgressReporter;
}

export interface ExecutionTask {
  deps?: readonly string[];
  failPolicy: ExecutionTaskFailPolicy;
  id: string;
  kind: LiminaCheckRunTaskKind;
  name: string;
  order: number;
  resources: ResourceRequest;
  run: (context?: ExecutionTaskRunContext) => Promise<ExecutionTaskResult>;
}
