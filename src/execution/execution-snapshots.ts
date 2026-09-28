import { SerialSnapshotWriterQueue } from '../check-reporting/atomic-writer';
import {
  assertCompletedRunSummary,
  CHECK_ISSUE_SNAPSHOT_VERSION,
  type CheckIssueSnapshot,
  createCompletedSourceIssueSnapshot,
  createNotRunSourceIssueSnapshot,
  type LiminaCheckIssue,
  writeCheckIssueSnapshotOnly,
  writeSourceIssueSnapshotOnly,
} from '../check-reporting/snapshot';
import {
  completeCheckAttempt,
  failCheckAttemptPersistence,
  type PublishedCheckAttempt,
} from '../source-check/snapshot/check-attempt-io';
import type { RunExecutionPlanOptions } from './executor-types';
import { nowIso } from './task-observers';
import type { ExecutionTask, StartedTaskResult } from './tasks';

function ignoreError(error: unknown): void {
  String(error);
}

function hasSourceTask(tasks: readonly ExecutionTask[]): boolean {
  return tasks.some((task) => task.issueTask === 'source:check');
}

function isCurrentSourceTask(options: {
  finalRepositoryGeneration: number;
  sourceTask: ExecutionTask | undefined;
}): boolean {
  if (options.sourceTask === undefined) return false;
  return options.sourceTask.generation === options.finalRepositoryGeneration;
}

function hasSourceOutcomeSnapshot(
  sourceOutcome: StartedTaskResult | undefined,
): boolean {
  if (sourceOutcome === undefined) return false;
  return sourceOutcome.sourceSnapshot !== undefined;
}

function hasCurrentSourceSnapshot(options: {
  finalRepositoryGeneration: number;
  sourceOutcome: StartedTaskResult | undefined;
  sourceTask: ExecutionTask | undefined;
}): boolean {
  if (!isCurrentSourceTask(options)) return false;
  return hasSourceOutcomeSnapshot(options.sourceOutcome);
}

function createSourceSnapshot(options: {
  command: string;
  finalRepositoryGeneration: number;
  rootDir: string;
  sourceOutcome: StartedTaskResult | undefined;
  sourceTask: ExecutionTask | undefined;
}) {
  if (!hasCurrentSourceSnapshot(options)) {
    return createNotRunSourceIssueSnapshot(options.command);
  }
  return createCompletedSourceIssueSnapshot({
    command: options.command,
    issues: options.sourceOutcome!.sourceSnapshot!.issues,
    rootDir: options.rootDir,
  });
}

function getSourceWriter(execution: RunExecutionPlanOptions) {
  const writer = execution.snapshotWriters?.writeSource;
  return writer === undefined ? writeSourceIssueSnapshotOnly : writer;
}

function getCheckWriter(execution: RunExecutionPlanOptions) {
  const writer = execution.snapshotWriters?.writeCheck;
  return writer === undefined ? writeCheckIssueSnapshotOnly : writer;
}

async function enqueueSourceSnapshot(options: {
  execution: RunExecutionPlanOptions;
  finalRepositoryGeneration: number;
  sourceOutcome: StartedTaskResult | undefined;
  sourceTask: ExecutionTask | undefined;
  tasks: readonly ExecutionTask[];
  writer: SerialSnapshotWriterQueue;
}): Promise<boolean> {
  if (!hasSourceTask(options.tasks)) return false;
  const sourceSnapshot = createSourceSnapshot({
    command: options.execution.command,
    finalRepositoryGeneration: options.finalRepositoryGeneration,
    rootDir: options.execution.rootDir,
    sourceOutcome: options.sourceOutcome,
    sourceTask: options.sourceTask,
  });
  const writeSource = getSourceWriter(options.execution);
  await options.writer.enqueue(() =>
    writeSource(options.execution.preflight.artifactNamespace, sourceSnapshot),
  );
  return true;
}

const missingRunSummary = new Map().get('missing');

function getCompletedRunSummary(execution: RunExecutionPlanOptions) {
  const recorder = execution.checkRunRecorder;
  if (recorder === undefined) return missingRunSummary;
  const run = recorder.getRunSummary();
  if (run !== undefined) assertCompletedRunSummary(run);
  return run;
}

async function enqueueCheckSnapshot(options: {
  attempt: PublishedCheckAttempt;
  execution: RunExecutionPlanOptions;
  issues: readonly LiminaCheckIssue[];
  sourceSnapshotPersisted: boolean;
  writer: SerialSnapshotWriterQueue;
}): Promise<void> {
  const writeCheck = getCheckWriter(options.execution);
  const run = getCompletedRunSummary(options.execution);
  const snapshot: CheckIssueSnapshot = {
    command: options.execution.command,
    createdAt: nowIso(),
    issues: [...options.issues],
    run,
    status: 'completed' as const,
    version: CHECK_ISSUE_SNAPSHOT_VERSION,
  };
  await options.writer.enqueue(() =>
    completeCheckAttempt({
      attempt: options.attempt,
      namespace: options.execution.preflight.artifactNamespace,
      snapshot,
      sourceSnapshotPersisted: options.sourceSnapshotPersisted,
      warn: (message) => options.execution.flow?.warn(message),
      writeSnapshot: writeCheck,
    }),
  );
}

export async function writeExecutionSnapshots(options: {
  attempt: PublishedCheckAttempt;
  execution: RunExecutionPlanOptions;
  finalRepositoryGeneration: number;
  issues: readonly LiminaCheckIssue[];
  sourceTask: ExecutionTask | undefined;
  sourceOutcome: StartedTaskResult | undefined;
  tasks: readonly ExecutionTask[];
}): Promise<void> {
  const writer = new SerialSnapshotWriterQueue();
  let sourceSnapshotPersisted = false;
  try {
    sourceSnapshotPersisted = await enqueueSourceSnapshot({
      ...options,
      writer,
    });
    await enqueueCheckSnapshot({
      attempt: options.attempt,
      execution: options.execution,
      issues: options.issues,
      sourceSnapshotPersisted,
      writer,
    });
    await writer.flush();
  } catch (error) {
    await failCheckAttemptPersistence({
      attempt: options.attempt,
      error,
      namespace: options.execution.preflight.artifactNamespace,
      sourceSnapshotPersisted,
    }).catch(ignoreError);
    throw error;
  }
}

function formatSnapshotError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warnSnapshotFailure(options: {
  error: unknown;
  execution: RunExecutionPlanOptions;
}): void {
  const flow = options.execution.flow;
  if (flow === undefined) return;
  flow.warn(
    `Unable to write the failed-run snapshot; the original check failure remains authoritative: ${formatSnapshotError(options.error)}`,
  );
}

function handleSnapshotWriteFailure(options: {
  completedState: 'blocked' | 'failed' | 'passed';
  error: unknown;
  execution: RunExecutionPlanOptions;
}): void {
  if (options.completedState === 'passed') throw options.error;
  warnSnapshotFailure(options);
}

export async function writeSnapshotsPreservingFailure(options: {
  attempt: PublishedCheckAttempt;
  completedState: 'blocked' | 'failed' | 'passed';
  execution: RunExecutionPlanOptions;
  finalRepositoryGeneration: number;
  issues: readonly LiminaCheckIssue[];
  sourceOutcome: StartedTaskResult | undefined;
  sourceTask: ExecutionTask | undefined;
  tasks: readonly ExecutionTask[];
}): Promise<void> {
  try {
    await writeExecutionSnapshots(options);
  } catch (error) {
    handleSnapshotWriteFailure({ ...options, error });
  }
}
