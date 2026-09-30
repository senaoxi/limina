import { isIntegerNumber } from '#utils/validation/is-integer';
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

const successfulStartedStates = new Set(['disabled', 'passed']);

function isSuccessfulTaskHasReason(task: LiminaCheckRunTaskSummary): boolean {
  return successfulStartedStates.has(task.state) && task.reason !== undefined;
}

function isDisabledTaskHasStatistics(task: LiminaCheckRunTaskSummary): boolean {
  return task.state === 'disabled' && hasRunnerStatistics(task);
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
      isSuccessfulTaskHasReason(task),
      `Passed or disabled task "${task.label}" must not carry reason.`,
    ),
    problemWhen(
      isDisabledTaskHasStatistics(task),
      `Disabled task "${task.label}" must not carry runner statistics.`,
    ),
  ]);
}

function getStartedTaskProblem(task: LiminaCheckRunTaskSummary): string | null {
  return firstProblem([
    getStartedTaskTimingProblem(task),
    getStartedTaskMetadataProblem(task),
  ]);
}

function isSyntheticTaskCarriesRunnerData(
  task: LiminaCheckRunTaskSummary,
): boolean {
  const hasTiming = [task.startedAt, task.completedAt, task.durationMs].some(
    (value) => value !== undefined,
  );
  return hasTiming || hasRunnerStatistics(task);
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
    isSyntheticTaskCarriesRunnerData(task),
    `Synthetic task "${task.label}" carries runner data.`,
  );
  if (dataProblem !== null) return dataProblem;
  return task.state === 'blocked'
    ? getBlockedTaskProblem(task)
    : getSkippedTaskProblem(task);
}

function isStartedTask(task: LiminaCheckRunTaskSummary): boolean {
  return ['disabled', 'failed', 'passed'].includes(task.state);
}

function getTaskLifecycleProblem(
  task: LiminaCheckRunTaskSummary,
): string | null {
  return isStartedTask(task)
    ? getStartedTaskProblem(task)
    : getSyntheticTaskProblem(task);
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
      !isIntegerNumber(task.generation) || task.generation < 0,
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
  return options.root?.state === 'failed'
    ? null
    : `Task "${options.task.label}" blocker is not an actual failed task.`;
}

function getTaskBlockerLabelProblem(options: {
  blockerLabel: string;
  blockerId: string;
  root: LiminaCheckRunTaskSummary | undefined;
}): string | null {
  return options.root === undefined ||
    options.root.label === options.blockerLabel
    ? null
    : `Task blocker label mismatch for "${options.blockerId}".`;
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
