import type { LiminaCheckIssue } from '../check-reporting/snapshot';
import { createSourceCheckIssue } from '../check-reporting/snapshot';
import type {
  ExecutionTaskResultView,
  RunExecutionResult,
} from './executor-types';
import { sortCollectedIssues } from './issues';
import type {
  CompletedRunOutcome,
  ExecutionTask,
  ExecutionTaskOutcome,
  StartedTaskResult,
  TaskId,
} from './tasks';
import { taskReference } from './tasks';

type RootBlocker = ReturnType<typeof taskReference> | undefined;
type RootBlockerResolver = (
  dependencyTask: ExecutionTask,
  dependencyOutcome: ExecutionTaskOutcome,
) => RootBlocker;

function resolvePassedBlocker(): undefined {
  return undefined;
}

function resolveBlockedBlocker(
  _task: ExecutionTask,
  outcome: Extract<ExecutionTaskOutcome, { status: 'blocked' }>,
): RootBlocker {
  return outcome.blockedBy;
}

function resolveSkippedBlocker(
  task: ExecutionTask,
  outcome: Extract<ExecutionTaskOutcome, { status: 'skipped' }>,
): RootBlocker {
  if (outcome.causedBy !== undefined) return outcome.causedBy;
  throw new Error(`Skipped task "${task.label}" is missing its root cause.`);
}

function resolveFailedBlocker(task: ExecutionTask): RootBlocker {
  return taskReference(task);
}

const rootBlockerResolvers: Record<
  ExecutionTaskOutcome['status'],
  RootBlockerResolver
> = {
  blocked: resolveBlockedBlocker as RootBlockerResolver,
  disabled: resolvePassedBlocker,
  failed: resolveFailedBlocker,
  passed: resolvePassedBlocker,
  skipped: resolveSkippedBlocker as RootBlockerResolver,
};

export function resolveRootBlocker(
  dependencyTask: ExecutionTask,
  dependencyOutcome: ExecutionTaskOutcome,
): RootBlocker {
  return rootBlockerResolvers[dependencyOutcome.status](
    dependencyTask,
    dependencyOutcome,
  );
}

function findSkippedOutcome(options: {
  orderedTasks: readonly ExecutionTask[];
  outcomes: ReadonlyMap<TaskId, ExecutionTaskOutcome>;
}): Extract<ExecutionTaskOutcome, { status: 'skipped' }> | undefined {
  return options.orderedTasks
    .map((task) => options.outcomes.get(task.id))
    .find(
      (
        outcome,
      ): outcome is Extract<ExecutionTaskOutcome, { status: 'skipped' }> =>
        outcome?.status === 'skipped',
    );
}

function findBlockedOutcome(options: {
  orderedTasks: readonly ExecutionTask[];
  outcomes: ReadonlyMap<TaskId, ExecutionTaskOutcome>;
}): Extract<ExecutionTaskOutcome, { status: 'blocked' }> | undefined {
  return options.orderedTasks
    .map((task) => options.outcomes.get(task.id))
    .find(
      (
        outcome,
      ): outcome is Extract<ExecutionTaskOutcome, { status: 'blocked' }> =>
        outcome?.status === 'blocked',
    );
}

function hasBlockedOutcome(options: {
  orderedTasks: readonly ExecutionTask[];
  outcomes: ReadonlyMap<TaskId, ExecutionTaskOutcome>;
}): boolean {
  return options.orderedTasks.some((task) => {
    const status = options.outcomes.get(task.id)?.status;
    return status === 'blocked' || status === 'skipped';
  });
}

function createSkippedRunOutcome(
  skipped: Extract<ExecutionTaskOutcome, { status: 'skipped' }>,
): CompletedRunOutcome {
  if (skipped.causedBy !== undefined) {
    return { blocker: skipped.causedBy, state: 'blocked' };
  }
  throw new Error('Skipped task outcome is missing its root cause.');
}

function createDirectBlockedRunOutcome(options: {
  orderedTasks: readonly ExecutionTask[];
  outcomes: ReadonlyMap<TaskId, ExecutionTaskOutcome>;
}): CompletedRunOutcome {
  const blocked = findBlockedOutcome(options);
  return { blocker: blocked?.blockedBy, state: 'blocked' };
}

function createBlockedRunOutcome(options: {
  orderedTasks: readonly ExecutionTask[];
  outcomes: ReadonlyMap<TaskId, ExecutionTaskOutcome>;
}): CompletedRunOutcome {
  const skipped = findSkippedOutcome(options);
  if (skipped === undefined) return createDirectBlockedRunOutcome(options);
  return createSkippedRunOutcome(skipped);
}

function hasFailedOutcome(options: {
  orderedTasks: readonly ExecutionTask[];
  outcomes: ReadonlyMap<TaskId, ExecutionTaskOutcome>;
}): boolean {
  return options.orderedTasks.some(
    (task) => options.outcomes.get(task.id)?.status === 'failed',
  );
}

export function createCompletedRunOutcome(
  orderedTasks: readonly ExecutionTask[],
  outcomes: ReadonlyMap<TaskId, ExecutionTaskOutcome>,
): CompletedRunOutcome {
  const options = { orderedTasks, outcomes };
  if (hasBlockedOutcome(options)) return createBlockedRunOutcome(options);
  return hasFailedOutcome(options) ? { state: 'failed' } : { state: 'passed' };
}

const startedOutcomeStatuses = new Set(['disabled', 'failed', 'passed']);

function isStartedOutcome(
  outcome: ExecutionTaskOutcome | undefined,
): outcome is StartedTaskResult {
  if (outcome === undefined) return false;
  return startedOutcomeStatuses.has(outcome.status);
}

export function collectExecutionIssues(options: {
  orderedTasks: readonly ExecutionTask[];
  outcomes: ReadonlyMap<TaskId, ExecutionTaskOutcome>;
  rootDir: string;
}): LiminaCheckIssue[] {
  const orderedStartedIssues = options.orderedTasks.flatMap((task) => {
    const outcome = options.outcomes.get(task.id);
    if (!isStartedOutcome(outcome)) return [];
    const sourceIssues = outcome.sourceSnapshot
      ? outcome.sourceSnapshot.issues.map((issue) =>
          createSourceCheckIssue({ issue, rootDir: options.rootDir }),
        )
      : [];
    return [
      {
        issues: [...outcome.issues, ...sourceIssues],
        taskId: task.id,
        taskOrder: task.order,
      },
    ];
  });
  return sortCollectedIssues(orderedStartedIssues);
}

function createStartedResultView(options: {
  outcome: StartedTaskResult;
  task: ExecutionTask;
}): ExecutionTaskResultView {
  return {
    durationMs: options.outcome.durationMs,
    id: options.task.id,
    issues: options.outcome.issues,
    label: options.task.label,
    passed:
      options.outcome.status === 'passed' ||
      options.outcome.status === 'disabled',
    status: options.outcome.status,
  };
}

function createSyntheticResultView(options: {
  outcome: Exclude<ExecutionTaskOutcome, StartedTaskResult>;
  task: ExecutionTask;
}): ExecutionTaskResultView {
  return {
    id: options.task.id,
    issues: [],
    label: options.task.label,
    passed: false,
    status: options.outcome.status,
  };
}

function createResultView(options: {
  outcome: ExecutionTaskOutcome;
  task: ExecutionTask;
}): ExecutionTaskResultView {
  if (isStartedOutcome(options.outcome)) {
    return createStartedResultView({ ...options, outcome: options.outcome });
  }
  return createSyntheticResultView({ ...options, outcome: options.outcome });
}

export function createExecutionResult(options: {
  issues: LiminaCheckIssue[];
  orderedTasks: readonly ExecutionTask[];
  outcome: CompletedRunOutcome;
  outcomes: ReadonlyMap<TaskId, ExecutionTaskOutcome>;
}): RunExecutionResult {
  return {
    issues: options.issues,
    outcome: options.outcome,
    passed: options.outcome.state === 'passed',
    results: options.orderedTasks.map((task) =>
      createResultView({ outcome: options.outcomes.get(task.id)!, task }),
    ),
  };
}

export function selectSourceOutcome(options: {
  orderedTasks: readonly ExecutionTask[];
  outcomes: ReadonlyMap<TaskId, ExecutionTaskOutcome>;
}): {
  sourceOutcome: StartedTaskResult | undefined;
  sourceTask: ExecutionTask | undefined;
} {
  const sourceTask = options.orderedTasks.findLast(
    (task) => task.issueTask === 'source:check',
  );
  const candidate =
    sourceTask === undefined ? undefined : options.outcomes.get(sourceTask.id);
  return {
    sourceOutcome: isStartedOutcome(candidate) ? candidate : undefined,
    sourceTask,
  };
}
