import type { PipelineStep } from '#config/runner';
import type { AnalysisProviderSet } from '#core';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type {
  ChildProcess,
  SpawnOptions,
  SpawnSyncOptions,
} from 'node:child_process';
import type { CheckIssueReportOptions } from '../check-reporting/human';
import type {
  CheckRunRecorder,
  LiminaCheckRunTaskStats,
} from '../check-reporting/run-recorder';
import type {
  RunExecutionPlanOptions,
  RunExecutionResult,
} from '../execution/executor';
import type { TaskProgressReporter } from '../execution/progress';
import type { ExecutionPlan } from '../execution/tasks';
import type { LiminaFlowReporter } from '../flow';
import type { LiminaPreflightManager } from '../preflight';
import type {
  SourceCheckIssue,
  SourceIssueReportOptions,
} from '../source-check/report';
import type { LiminaCheckIssue } from '../source-check/snapshot';
import type { CheckerFailureTarget } from '../typecheck/runner';
import type { TypecheckTargetResult } from '../typecheck/targets';

export interface RunPipelineOptions {
  checkRunRecorder?: CheckRunRecorder;
  checkIssueReport?: CheckIssueReportOptions;
  commandProcess?: CommandProcessDependencies;
  providers?: AnalysisProviderSet;
  cwd?: string;
  flow?: LiminaFlowReporter;
  generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
  packageNames?: readonly string[];
  preflight?: LiminaPreflightManager;
  resolveKnipCliPath?: () => string;
  progress?: TaskProgressReporter;
  sourceIssueReport?: SourceIssueReportOptions;
  executionPlan?: ExecutionPlan;
  snapshotWriters?: RunExecutionPlanOptions['snapshotWriters'];
}

export interface CommandProcessDependencies {
  readonly spawn?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
  readonly spawnSync?: (
    command: string,
    args: readonly string[],
    options: SpawnSyncOptions,
  ) => {
    readonly error?: Error;
    readonly signal: NodeJS.Signals | null;
    readonly status: number | null;
  };
  readonly timeoutMs?: number;
}

export type NormalizedPipelineStep = Exclude<PipelineStep, string>;

export interface BuiltinTaskResult {
  disabled?: boolean;
  issues: readonly LiminaCheckIssue[];
  passed: boolean;
  sourceSnapshot?: {
    issues: readonly SourceCheckIssue[];
    status: 'completed';
  };
  stats?: LiminaCheckRunTaskStats;
}

export interface CheckerTaskStatsInput {
  disabled?: boolean;
  failedTargets: readonly CheckerFailureTarget[];
  passed: boolean;
  problems?: readonly string[];
  projectRootDir: string;
  rootConfigPaths: readonly string[];
  targetResults: readonly TypecheckTargetResult[];
}

export type PipelineExecutionResult = RunExecutionResult;
