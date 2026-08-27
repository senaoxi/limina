import {
  getCompletedTaskSemanticProblem,
  getTaskBlockerProblem,
  hasRunnerStatistics,
} from './task-semantics';
import type { LiminaCheckRunSummary, LiminaCheckRunTaskSummary } from './types';
import {
  firstProblem,
  isFiniteNonNegativeNumber,
  problemWhen,
} from './validation-shared';

function getPassedRunProblem(run: LiminaCheckRunSummary): string | null {
  const message =
    'Passed run must contain only passed or disabled tasks and no blocker.';
  return firstProblem([
    problemWhen(run.blockedBy !== undefined, message),
    problemWhen(
      !run.tasks.every((task) => ['disabled', 'passed'].includes(task.state)),
      message,
    ),
  ]);
}

function hasSyntheticRunTask(run: LiminaCheckRunSummary): boolean {
  return run.tasks.some(
    (task) => task.state === 'blocked' || task.state === 'skipped',
  );
}

function getFailedRunProblem(run: LiminaCheckRunSummary): string | null {
  const message =
    'Failed run must contain a failed task and no blocked or skipped tasks.';
  return firstProblem([
    problemWhen(run.blockedBy !== undefined, message),
    problemWhen(!run.tasks.some((task) => task.state === 'failed'), message),
    problemWhen(hasSyntheticRunTask(run), message),
  ]);
}

function getBlockedRunRootProblem(
  root: LiminaCheckRunTaskSummary | undefined,
): string | null {
  if (root?.state === 'failed') return null;
  return 'Blocked run blocker is not an actual failed task.';
}

function getBlockedRunProblem(options: {
  run: LiminaCheckRunSummary;
  taskById: ReadonlyMap<string, LiminaCheckRunTaskSummary>;
}): string | null {
  const blocker = options.run.blockedBy;
  if (blocker === undefined) {
    return 'Blocked run must contain a synthetic task and a run blocker.';
  }
  const root = options.taskById.get(blocker.id);
  return firstProblem([
    problemWhen(
      !hasSyntheticRunTask(options.run),
      'Blocked run must contain a synthetic task and a run blocker.',
    ),
    getBlockedRunRootProblem(root),
    problemWhen(
      root !== undefined && root.label !== blocker.label,
      `Run blocker label mismatch for "${blocker.id}".`,
    ),
  ]);
}

function getRunResultProblem(options: {
  run: LiminaCheckRunSummary;
  taskById: ReadonlyMap<string, LiminaCheckRunTaskSummary>;
}): string | null {
  if (options.run.result === 'passed') return getPassedRunProblem(options.run);
  if (options.run.result === 'failed') return getFailedRunProblem(options.run);
  return getBlockedRunProblem(options);
}

function isTerminalRunResult(run: LiminaCheckRunSummary): boolean {
  return ['blocked', 'failed', 'passed'].includes(run.result);
}

function getCompletedRunHeaderProblem(
  run: LiminaCheckRunSummary,
): string | null {
  return firstProblem([
    problemWhen(
      !isTerminalRunResult(run),
      `Completed run has non-terminal result "${run.result}".`,
    ),
    problemWhen(
      !run.startedAt || !run.completedAt,
      'Completed run is missing startedAt or completedAt.',
    ),
    problemWhen(
      !isFiniteNonNegativeNumber(run.durationMs),
      'Completed run has invalid durationMs.',
    ),
    problemWhen(
      run.tasks.length === 0,
      'Completed run must contain at least one task.',
    ),
  ]);
}

function addIndexedTask(options: {
  task: LiminaCheckRunTaskSummary;
  taskById: Map<string, LiminaCheckRunTaskSummary>;
}): string | null {
  if (options.taskById.has(options.task.id)) {
    return `Completed run contains duplicate task id "${options.task.id}".`;
  }
  const problem = getCompletedTaskSemanticProblem(options.task);
  if (problem !== null) return problem;
  options.taskById.set(options.task.id, options.task);
  return null;
}

function indexCompletedTasks(
  run: LiminaCheckRunSummary,
): Map<string, LiminaCheckRunTaskSummary> | string {
  const taskById = new Map<string, LiminaCheckRunTaskSummary>();
  for (const task of run.tasks) {
    const problem = addIndexedTask({ task, taskById });
    if (problem !== null) return problem;
  }
  return taskById;
}

function getTaskRelationProblem(options: {
  run: LiminaCheckRunSummary;
  taskById: ReadonlyMap<string, LiminaCheckRunTaskSummary>;
}): string | null {
  return firstProblem(
    options.run.tasks.map((task) =>
      getTaskBlockerProblem({ task, taskById: options.taskById }),
    ),
  );
}

function getIndexedRunProblem(options: {
  run: LiminaCheckRunSummary;
  taskById: ReadonlyMap<string, LiminaCheckRunTaskSummary>;
}): string | null {
  return firstProblem([
    getTaskRelationProblem(options),
    getRunResultProblem(options),
  ]);
}

export function getCompletedRunSemanticProblem(
  run: LiminaCheckRunSummary,
): string | null {
  const headerProblem = getCompletedRunHeaderProblem(run);
  if (headerProblem !== null) return headerProblem;
  const taskById = indexCompletedTasks(run);
  if (typeof taskById === 'string') return taskById;
  return getIndexedRunProblem({ run, taskById });
}

export function assertCompletedRunSummary(run: LiminaCheckRunSummary): void {
  const problem = getCompletedRunSemanticProblem(run);
  if (problem === null) return;
  throw new Error(`Invalid completed check run summary: ${problem}`);
}

function plannedTaskCarriesExecutionData(
  task: LiminaCheckRunTaskSummary,
): boolean {
  return [
    task.state !== 'planned',
    task.startedAt !== undefined,
    task.completedAt !== undefined,
    task.durationMs !== undefined,
    task.blockedBy !== undefined,
    task.reason !== undefined,
    hasRunnerStatistics(task),
  ].some(Boolean);
}

function getPlannedTaskProblem(run: LiminaCheckRunSummary): string | null {
  const invalidTask = run.tasks.find(plannedTaskCarriesExecutionData);
  if (invalidTask === undefined) return null;
  return `Planned task "${invalidTask.label}" carries execution data.`;
}

function notRunCarriesExecutionState(run: LiminaCheckRunSummary): boolean {
  return [
    run.result !== 'not-run',
    run.startedAt !== undefined,
    run.completedAt !== undefined,
    run.durationMs !== undefined,
    run.blockedBy !== undefined,
  ].some(Boolean);
}

export function getNotRunSummaryProblem(
  run: LiminaCheckRunSummary,
): string | null {
  return firstProblem([
    problemWhen(
      notRunCarriesExecutionState(run),
      'Not-run summary carries execution state.',
    ),
    getPlannedTaskProblem(run),
  ]);
}
