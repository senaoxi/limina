import { getCheckerTargetRelationProblem } from './checker-target-semantics';
import type { LiminaCheckRunTaskSummary } from './types';
import {
  firstProblem,
  isFiniteNonNegativeNumber,
  problemWhen,
} from './validation-shared';

export function hasRunnerStatistics(task: LiminaCheckRunTaskSummary): boolean {
  return [task.checkItems, task.checksPassed, task.checksTotal].some(
    (value) => value !== undefined,
  );
}

function getStartedTaskTimingProblem(
  task: LiminaCheckRunTaskSummary,
): string | null {
  const message = `Started task "${task.label}" has incomplete timing.`;
  return firstProblem([
    problemWhen(task.startedAt === undefined, message),
    problemWhen(task.completedAt === undefined, message),
    problemWhen(!isFiniteNonNegativeNumber(task.durationMs), message),
  ]);
}

function getStartedTaskMetadataProblem(
  task: LiminaCheckRunTaskSummary,
): string | null {
  return firstProblem([
    problemWhen(
      task.blockedBy !== undefined,
      `Started task "${task.label}" must not carry blockedBy.`,
    ),
    problemWhen(
      task.state === 'passed' && task.reason !== undefined,
      `Passed task "${task.label}" must not carry reason.`,
    ),
  ]);
}

function getStartedTaskProblem(task: LiminaCheckRunTaskSummary): string | null {
  return firstProblem([
    getStartedTaskTimingProblem(task),
    getStartedTaskMetadataProblem(task),
  ]);
}

function syntheticTaskCarriesRunnerData(
  task: LiminaCheckRunTaskSummary,
): boolean {
  const hasTiming = [task.startedAt, task.completedAt, task.durationMs].some(
    (value) => value !== undefined,
  );
  if (hasTiming) return true;
  return hasRunnerStatistics(task);
}

function getBlockedTaskProblem(task: LiminaCheckRunTaskSummary): string | null {
  const message = `Blocked task "${task.label}" is missing its blocker or carries reason.`;
  return firstProblem([
    problemWhen(task.blockedBy === undefined, message),
    problemWhen(task.reason !== undefined, message),
  ]);
}

function getSkippedTaskProblem(task: LiminaCheckRunTaskSummary): string | null {
  const message = `Skipped task "${task.label}" is missing reason or carries blockedBy.`;
  return firstProblem([
    problemWhen(!task.reason, message),
    problemWhen(task.blockedBy !== undefined, message),
  ]);
}

function getSyntheticTaskProblem(
  task: LiminaCheckRunTaskSummary,
): string | null {
  const dataProblem = problemWhen(
    syntheticTaskCarriesRunnerData(task),
    `Synthetic task "${task.label}" carries runner data.`,
  );
  if (dataProblem !== null) return dataProblem;
  if (task.state === 'blocked') return getBlockedTaskProblem(task);
  return getSkippedTaskProblem(task);
}

function isStartedTask(task: LiminaCheckRunTaskSummary): boolean {
  return task.state === 'passed' || task.state === 'failed';
}

function getTaskLifecycleProblem(
  task: LiminaCheckRunTaskSummary,
): string | null {
  if (isStartedTask(task)) return getStartedTaskProblem(task);
  return getSyntheticTaskProblem(task);
}

export function getCompletedTaskSemanticProblem(
  task: LiminaCheckRunTaskSummary,
): string | null {
  return firstProblem([
    problemWhen(
      task.id.startsWith('checker-target:'),
      `Execution task id "${task.id}" uses the checker-target namespace.`,
    ),
    problemWhen(
      !Number.isInteger(task.generation) || task.generation < 0,
      `Task "${task.label}" has invalid generation.`,
    ),
    problemWhen(
      task.state === 'planned' || task.state === 'running',
      `Completed run contains non-terminal task "${task.label}".`,
    ),
    getTaskLifecycleProblem(task),
    getCheckerTargetRelationProblem(task),
  ]);
}

function getMissingTaskBlockerProblem(options: {
  root: LiminaCheckRunTaskSummary | undefined;
  task: LiminaCheckRunTaskSummary;
}): string | null {
  if (options.root?.state === 'failed') return null;
  return `Task "${options.task.label}" blocker is not an actual failed task.`;
}

function getTaskBlockerLabelProblem(options: {
  blockerLabel: string;
  blockerId: string;
  root: LiminaCheckRunTaskSummary | undefined;
}): string | null {
  if (options.root === undefined) return null;
  if (options.root.label === options.blockerLabel) return null;
  return `Task blocker label mismatch for "${options.blockerId}".`;
}

export function getTaskBlockerProblem(options: {
  task: LiminaCheckRunTaskSummary;
  taskById: ReadonlyMap<string, LiminaCheckRunTaskSummary>;
}): string | null {
  const blocker = options.task.blockedBy;
  if (blocker === undefined) return null;
  const root = options.taskById.get(blocker.id);
  return firstProblem([
    problemWhen(
      blocker.id === options.task.id,
      `Task "${options.task.label}" cannot block itself.`,
    ),
    getMissingTaskBlockerProblem({ root, task: options.task }),
    getTaskBlockerLabelProblem({
      blockerId: blocker.id,
      blockerLabel: blocker.label,
      root,
    }),
  ]);
}
