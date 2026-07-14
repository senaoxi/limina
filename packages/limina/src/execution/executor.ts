import { SerialSnapshotWriterQueue } from '../check-reporting/atomic-writer';
import { LiminaStructuredError } from '../check-reporting/errors';
import type {
  CheckRunRecorder,
  LiminaCheckRunTaskStats,
} from '../check-reporting/run-recorder';
import {
  assertCompletedRunSummary,
  CHECK_ISSUE_SNAPSHOT_VERSION,
  type CheckIssueSnapshot,
  createCompletedSourceIssueSnapshot,
  createNotRunSourceIssueSnapshot,
  createSourceCheckIssue,
  createTaskFailureIssue,
  type LiminaCheckIssue,
  type SourceIssueSnapshot,
  writeCheckIssueSnapshotOnly,
  writeSourceIssueSnapshotOnly,
} from '../check-reporting/snapshot';
import type { LiminaFlowReporter, LiminaFlowTreeNode } from '../flow';
import type { LiminaPreflightManager } from '../preflight';
import { createPreflightGenerationController } from '../preflight/generation';
import { resolveTaskConcurrency } from './config';
import { sortCollectedIssues } from './issues';
import { createTaskProgressReporter } from './progress';
import { ResourceLockSet, type ResourceRequest } from './resources';
import { ExecutionStateStore } from './state-store';
import type {
  CompletedRunOutcome,
  ExecutionPlan,
  ExecutionTask,
  ExecutionTaskOutcome,
  StartedTaskResult,
  TaskId,
  TaskLifecycleEvent,
} from './tasks';
import { taskReference } from './tasks';

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
    writeCheck(rootDir: string, snapshot: CheckIssueSnapshot): Promise<void>;
    writeSource(rootDir: string, snapshot: SourceIssueSnapshot): Promise<void>;
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

type StartDecision = { type: 'run' } | { error: unknown; type: 'abort' };
type RunningTaskSettlement =
  | { outcome: StartedTaskResult; type: 'task' }
  | { error: unknown; type: 'infrastructure-start-failure' };

interface RunningTaskEntry {
  executionStarted: boolean;
  gate: Deferred<StartDecision>;
  locks: ResourceRequest;
  settlement: Promise<RunningTaskSettlement>;
  task: ExecutionTask;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function nowIso(): string {
  return new Date().toISOString();
}

function ignoreError(error: unknown): void {
  // Best-effort observer cleanup must not replace the primary error.
  String(error);
}

function formatFlowTaskName(task: ExecutionTask): string {
  if (task.kind === 'command') return `command: ${task.label}`;
  return task.label.replaceAll(':', ' ');
}

function assertActiveGeneration(
  task: ExecutionTask,
  activeGeneration: number,
): void {
  if (task.generation !== activeGeneration) {
    throw new Error(
      `Execution task "${task.label}" belongs to generation ${task.generation}, but the active repository generation is ${activeGeneration}.`,
    );
  }
}

export function resolveRootBlocker(
  dependencyTask: ExecutionTask,
  dependencyOutcome: ExecutionTaskOutcome,
): ReturnType<typeof taskReference> | undefined {
  if (dependencyOutcome.status === 'passed') return undefined;
  if (dependencyOutcome.status === 'blocked') {
    return dependencyOutcome.blockedBy;
  }
  if (dependencyOutcome.status === 'skipped') {
    if (!dependencyOutcome.causedBy) {
      throw new Error(
        `Skipped task "${dependencyTask.label}" is missing its root cause.`,
      );
    }
    return dependencyOutcome.causedBy;
  }
  return taskReference(dependencyTask);
}

function createInfrastructureIssue(
  task: ExecutionTask,
  rootDir: string,
  error: unknown,
): LiminaCheckIssue {
  const message = error instanceof Error ? error.message : String(error);

  return createTaskFailureIssue({
    code:
      task.issueTask === 'graph:materialize'
        ? 'LIMINA_GRAPH_MATERIALIZE_FAILED'
        : undefined,
    detailLines: [message],
    fix: `Inspect the ${task.issueTask} failure, then rerun limina check.`,
    reason: `${task.issueTask} failed: ${message}.`,
    rootDir,
    task: task.issueTask,
    title: `${task.issueTask} failed`,
  });
}

async function normalizeRunnerResult(
  task: ExecutionTask,
  options: RunExecutionPlanOptions,
  flowNode: LiminaFlowTreeNode | undefined,
): Promise<StartedTaskResult> {
  const startedAt = performance.now();

  try {
    const result = await task.run({
      flow: options.flow,
      preflight: options.preflight,
      progress: createTaskProgressReporter(flowNode),
    });

    if (result.status !== 'passed' && result.status !== 'failed') {
      throw new Error(
        `Task runner "${task.label}" returned scheduler-owned status.`,
      );
    }

    return { ...result, durationMs: performance.now() - startedAt };
  } catch (error) {
    const issues =
      error instanceof LiminaStructuredError
        ? error.issues
        : [createInfrastructureIssue(task, options.rootDir, error)];

    return {
      durationMs: performance.now() - startedAt,
      issues,
      status: 'failed',
    };
  }
}

function createRunningEntry(
  task: ExecutionTask,
  options: RunExecutionPlanOptions,
  flowNode: LiminaFlowTreeNode | undefined,
): RunningTaskEntry {
  const gate = createDeferred<StartDecision>();
  const entry: RunningTaskEntry = {
    executionStarted: false,
    gate,
    locks: task.resources,
    settlement: Promise.resolve(undefined as never),
    task,
  };

  entry.settlement = gate.promise.then(async (decision) => {
    if (decision.type === 'abort') {
      return {
        error: decision.error,
        type: 'infrastructure-start-failure' as const,
      };
    }

    entry.executionStarted = true;
    return {
      outcome: await normalizeRunnerResult(task, options, flowNode),
      type: 'task' as const,
    };
  });

  return entry;
}

async function projectRecorderAndFlow(
  task: ExecutionTask,
  event: TaskLifecycleEvent,
  recorder: CheckRunRecorder | undefined,
  flowNode: LiminaFlowTreeNode | undefined,
): Promise<void> {
  const observers = [
    () => recorder?.project(task, event),
    () => {
      switch (event.type) {
        case 'start': {
          flowNode?.start();
          return;
        }
        case 'pass': {
          flowNode?.pass(undefined, { elapsedTimeMs: event.durationMs });
          return;
        }
        case 'fail': {
          flowNode?.fail(undefined, { elapsedTimeMs: event.durationMs });
          return;
        }
        case 'block': {
          flowNode?.block(
            `${formatFlowTaskName(task)} (blocked by ${event.blockedBy.label})`,
          );
          return;
        }
        case 'skip': {
          flowNode?.skip(`${formatFlowTaskName(task)} (${event.reason})`);
        }
      }
    },
  ];
  const settled = await Promise.allSettled(
    observers.map(async (observer) => observer()),
  );
  const failures = settled.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );

  if (failures.length > 0) {
    const primary = failures[0];
    if (primary instanceof Error && failures.length > 1) {
      Object.defineProperty(primary, 'secondaryProjectionErrors', {
        configurable: true,
        value: failures.slice(1),
      });
    }
    throw primary;
  }
}

export function validateExecutionPlan(plan: ExecutionPlan): void {
  if (plan.tasks.length === 0) {
    throw new Error('Execution plan must contain at least one task.');
  }

  const ids = new Set(plan.tasks.map((task) => task.id));
  if (ids.size !== plan.tasks.length) {
    throw new Error('Execution plan contains duplicate task ids.');
  }

  const orderedTasks = [...plan.tasks].sort(
    (left, right) => left.order - right.order,
  );
  const generations = new Set<number>();
  let previousGeneration = -1;

  for (const task of orderedTasks) {
    if (!Number.isInteger(task.generation) || task.generation < 0) {
      throw new Error(
        `Execution task "${task.label}" has invalid generation "${task.generation}".`,
      );
    }
    if (task.generation < previousGeneration) {
      throw new Error('Execution plan generations must not decrease by order.');
    }
    previousGeneration = task.generation;
    generations.add(task.generation);

    for (const dependency of [
      ...(task.after ?? []),
      ...(task.requiresSuccessOf ?? []),
    ]) {
      if (!ids.has(dependency)) {
        throw new Error(
          `Execution task "${task.label}" references missing dependency "${dependency}".`,
        );
      }
      if (dependency === task.id) {
        throw new Error(`Execution task "${task.label}" depends on itself.`);
      }
      const dependencyTask = plan.tasks.find(
        (candidate) => candidate.id === dependency,
      )!;
      if (dependencyTask.generation > task.generation) {
        throw new Error(
          `Execution task "${task.label}" depends on future generation task "${dependencyTask.label}".`,
        );
      }
    }
  }

  const orderedGenerations = [...generations].sort(
    (left, right) => left - right,
  );
  if (orderedGenerations[0] !== 0) {
    throw new Error('Execution plan generations must start at 0.');
  }
  for (const [index, generation] of orderedGenerations.entries()) {
    if (generation !== index) {
      throw new Error('Execution plan generations must be continuous.');
    }
  }

  const maximumGeneration = orderedGenerations.at(-1)!;
  for (const generation of orderedGenerations) {
    const segmentTasks = orderedTasks.filter(
      (task) => task.generation === generation,
    );
    const advancementTasks = segmentTasks.filter(
      (task) => task.invalidatesPreflight === true,
    );
    if (advancementTasks.length > 1) {
      throw new Error(
        `Execution generation ${generation} contains multiple advancement commands.`,
      );
    }
    if (generation < maximumGeneration && advancementTasks.length !== 1) {
      throw new Error(
        `Execution generation ${generation} requires exactly one advancement command.`,
      );
    }
    const advancementTask = advancementTasks[0];
    if (!advancementTask) continue;
    if (
      advancementTask.kind !== 'command' ||
      advancementTask.failPolicy !== 'stop-pipeline'
    ) {
      throw new Error(
        `Execution generation ${generation} advancement must be a stop-pipeline command.`,
      );
    }
    if (segmentTasks.at(-1)?.id !== advancementTask.id) {
      throw new Error(
        `Execution generation ${generation} advancement command must be the final task in its generation.`,
      );
    }
  }

  const visiting = new Set<TaskId>();
  const visited = new Set<TaskId>();
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const visit = (taskId: TaskId): void => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) {
      throw new Error('Execution plan contains a dependency cycle.');
    }
    visiting.add(taskId);
    const task = byId.get(taskId)!;
    for (const dependency of new Set([
      ...(task.after ?? []),
      ...(task.requiresSuccessOf ?? []),
    ])) {
      visit(dependency);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of plan.tasks) visit(task.id);
}

export function createCompletedRunOutcome(
  orderedTasks: readonly ExecutionTask[],
  outcomes: ReadonlyMap<TaskId, ExecutionTaskOutcome>,
): CompletedRunOutcome {
  const hasBlocked = orderedTasks.some((task) => {
    const status = outcomes.get(task.id)?.status;
    return status === 'blocked' || status === 'skipped';
  });
  if (hasBlocked) {
    const skipped = orderedTasks
      .map((task) => outcomes.get(task.id))
      .find(
        (
          outcome,
        ): outcome is Extract<ExecutionTaskOutcome, { status: 'skipped' }> =>
          outcome?.status === 'skipped',
      );
    if (skipped) {
      if (!skipped.causedBy) {
        throw new Error('Skipped task outcome is missing its root cause.');
      }
      return { blocker: skipped.causedBy, state: 'blocked' };
    }

    const blocked = orderedTasks
      .map((task) => outcomes.get(task.id))
      .find(
        (
          outcome,
        ): outcome is Extract<ExecutionTaskOutcome, { status: 'blocked' }> =>
          outcome?.status === 'blocked',
      );
    return { blocker: blocked?.blockedBy, state: 'blocked' };
  }

  return orderedTasks.some((task) => outcomes.get(task.id)?.status === 'failed')
    ? { state: 'failed' }
    : { state: 'passed' };
}

async function writeExecutionSnapshots(options: {
  execution: RunExecutionPlanOptions;
  finalRepositoryGeneration: number;
  issues: readonly LiminaCheckIssue[];
  sourceTask: ExecutionTask | undefined;
  sourceOutcome: StartedTaskResult | undefined;
  tasks: readonly ExecutionTask[];
}): Promise<void> {
  const writer = new SerialSnapshotWriterQueue();
  const { execution } = options;
  const writeSource =
    execution.snapshotWriters?.writeSource ?? writeSourceIssueSnapshotOnly;
  const writeCheck =
    execution.snapshotWriters?.writeCheck ?? writeCheckIssueSnapshotOnly;
  const run = execution.checkRunRecorder?.getRunSummary();

  if (run) assertCompletedRunSummary(run);

  if (options.tasks.some((task) => task.issueTask === 'source:check')) {
    const sourceSnapshot =
      options.sourceTask?.generation === options.finalRepositoryGeneration &&
      options.sourceOutcome?.sourceSnapshot
        ? createCompletedSourceIssueSnapshot({
            command: execution.command,
            issues: options.sourceOutcome.sourceSnapshot.issues,
            rootDir: execution.rootDir,
          })
        : createNotRunSourceIssueSnapshot(execution.command);
    await writer.enqueue(() => writeSource(execution.rootDir, sourceSnapshot));
  }

  await writer.enqueue(() =>
    writeCheck(execution.rootDir, {
      command: execution.command,
      createdAt: nowIso(),
      issues: [...options.issues],
      run,
      status: 'completed',
      version: CHECK_ISSUE_SNAPSHOT_VERSION,
    }),
  );
  await writer.flush();
}

export async function runExecutionPlan(
  plan: ExecutionPlan,
  options: RunExecutionPlanOptions,
): Promise<{
  issues: LiminaCheckIssue[];
  outcome: CompletedRunOutcome;
  passed: boolean;
  results: ExecutionTaskResultView[];
}> {
  validateExecutionPlan(plan);
  const orderedTasks = [...plan.tasks].sort(
    (left, right) => left.order - right.order,
  );
  const state = new ExecutionStateStore(orderedTasks);
  const locks = new ResourceLockSet();
  const pending = new Map(orderedTasks.map((task) => [task.id, task]));
  const running = new Map<TaskId, RunningTaskEntry>();
  const outcomes = new Map<TaskId, ExecutionTaskOutcome>();
  const flowNodes = new Map<TaskId, LiminaFlowTreeNode>();
  const controller = createPreflightGenerationController(options.preflight);
  const concurrency = Math.max(
    1,
    resolveTaskConcurrency({
      config: options.preflight.config,
      itemCount: orderedTasks.length,
    }),
  );
  let pendingGenerationAdvance = false;
  let infrastructureError: unknown;

  for (const task of orderedTasks) {
    const node = options.flow?.tree(formatFlowTaskName(task), { depth: 1 });
    if (node) flowNodes.set(task.id, node);
  }

  const project = async (
    task: ExecutionTask,
    event: TaskLifecycleEvent,
  ): Promise<void> => {
    state.transition(task.id, event);
    await projectRecorderAndFlow(
      task,
      event,
      options.checkRunRecorder,
      flowNodes.get(task.id),
    );
  };

  const abortRegisteredStart = async (
    entry: RunningTaskEntry,
    error: unknown,
    stateBecameRunning: boolean,
  ): Promise<void> => {
    if (stateBecameRunning) {
      const cleanupEvent: TaskLifecycleEvent = {
        completedAt: nowIso(),
        durationMs: 0,
        reason: 'infrastructure start failure',
        type: 'fail',
      };
      state.transition(entry.task.id, cleanupEvent);
      await projectRecorderAndFlow(
        entry.task,
        cleanupEvent,
        options.checkRunRecorder,
        flowNodes.get(entry.task.id),
      ).catch(ignoreError);
    }
    entry.gate.resolve({ error, type: 'abort' });
    await entry.settlement;
    running.delete(entry.task.id);
    locks.release(entry.task.id);
  };

  const startTask = async (task: ExecutionTask): Promise<void> => {
    assertActiveGeneration(task, controller.generation);
    pending.delete(task.id);
    locks.acquire(task.id, task.resources);
    const entry = createRunningEntry(task, options, flowNodes.get(task.id));
    running.set(task.id, entry);
    let stateBecameRunning = false;
    try {
      const startEvent: TaskLifecycleEvent = {
        startedAt: nowIso(),
        type: 'start',
      };
      state.transition(task.id, startEvent);
      stateBecameRunning = true;
      await projectRecorderAndFlow(
        task,
        startEvent,
        options.checkRunRecorder,
        flowNodes.get(task.id),
      );
      entry.gate.resolve({ type: 'run' });
    } catch (error) {
      await abortRegisteredStart(entry, error, stateBecameRunning);
      throw error;
    }
  };

  const finishSynthetic = async (
    task: ExecutionTask,
    outcome: Extract<ExecutionTaskOutcome, { status: 'blocked' | 'skipped' }>,
  ): Promise<void> => {
    if (outcome.status === 'skipped' && !outcome.causedBy) {
      throw new Error(
        `Skipped task "${task.label}" is missing its root cause.`,
      );
    }
    pending.delete(task.id);
    outcomes.set(task.id, outcome);
    const event: TaskLifecycleEvent =
      outcome.status === 'blocked'
        ? { blockedBy: outcome.blockedBy, type: 'block' }
        : { reason: outcome.reason, type: 'skip' };
    await project(task, event);
  };

  const stopRemaining = async (blocker: ExecutionTask): Promise<void> => {
    const remaining = [...pending.values()]
      .filter((task) => task.order > blocker.order)
      .sort((left, right) => left.order - right.order);
    for (const task of remaining) {
      await finishSynthetic(task, {
        causedBy: taskReference(blocker),
        reason: `skipped after "${blocker.label}" failed`,
        status: 'skipped',
      });
    }
  };

  const settleEntry = async (entry: RunningTaskEntry): Promise<void> => {
    const settlement = await entry.settlement;
    try {
      if (settlement.type === 'infrastructure-start-failure') return;

      const outcome = settlement.outcome;
      outcomes.set(entry.task.id, outcome);
      if (entry.task.invalidatesPreflight) pendingGenerationAdvance = true;
      const completedAt = nowIso();
      const event: TaskLifecycleEvent =
        outcome.status === 'passed'
          ? {
              completedAt,
              durationMs: outcome.durationMs,
              stats: outcome.stats,
              type: 'pass',
            }
          : {
              completedAt,
              durationMs: outcome.durationMs,
              reason: `${entry.task.label} failed`,
              stats: outcome.stats,
              type: 'fail',
            };
      await project(entry.task, event);
      options.onTaskStats?.(entry.task, outcome.stats);
      if (
        outcome.status === 'failed' &&
        entry.task.failPolicy === 'stop-pipeline'
      ) {
        await stopRemaining(entry.task);
      }
    } finally {
      running.delete(entry.task.id);
      locks.release(entry.task.id);
    }
  };

  const joinRunning = async (): Promise<void> => {
    while (running.size > 0) {
      const entry = await Promise.race(
        [...running.values()].map(async (candidate) => {
          await candidate.settlement;
          return candidate;
        }),
      );
      try {
        await settleEntry(entry);
      } catch (error) {
        infrastructureError ??= error;
      }
    }
  };

  try {
    while (pending.size > 0 || running.size > 0) {
      if (infrastructureError !== undefined) break;

      if (pendingGenerationAdvance) {
        await joinRunning();
        if (infrastructureError !== undefined) break;
        controller.startNextGeneration();
        pendingGenerationAdvance = false;
        continue;
      }

      let progressed = false;
      for (const task of [...pending.values()].sort(
        (left, right) => left.order - right.order,
      )) {
        if (task.generation > controller.generation) continue;
        assertActiveGeneration(task, controller.generation);
        const required = task.requiresSuccessOf ?? [];
        const dependencies = new Set([...(task.after ?? []), ...required]);
        if ([...dependencies].some((id) => !outcomes.has(id))) continue;
        const blockedDependency = orderedTasks
          .filter((candidate) => required.includes(candidate.id))
          .map((dependencyTask) => {
            const dependencyOutcome = outcomes.get(dependencyTask.id);
            return dependencyOutcome
              ? {
                  blocker: resolveRootBlocker(
                    dependencyTask,
                    dependencyOutcome,
                  ),
                  dependencyTask,
                }
              : undefined;
          })
          .find((dependency) => dependency?.blocker);
        if (blockedDependency?.blocker) {
          await finishSynthetic(task, {
            blockedBy: blockedDependency.blocker,
            status: 'blocked',
          });
          progressed = true;
          continue;
        }
        if (running.size >= concurrency || !locks.canAcquire(task.resources)) {
          continue;
        }
        await startTask(task);
        progressed = true;
      }

      if (running.size > 0 && (!progressed || running.size >= concurrency)) {
        const entry = await Promise.race(
          [...running.values()].map(async (candidate) => {
            await candidate.settlement;
            return candidate;
          }),
        );
        await settleEntry(entry);
        continue;
      }

      if (!progressed && running.size === 0 && pending.size > 0) {
        throw new Error(
          'Execution scheduler reached an unresolved plan state.',
        );
      }
    }
  } catch (error) {
    infrastructureError ??= error;
  }

  if (infrastructureError !== undefined) {
    await joinRunning();
    if (pendingGenerationAdvance) {
      controller.startNextGeneration();
      pendingGenerationAdvance = false;
    }
    throw infrastructureError;
  }

  if (pendingGenerationAdvance) {
    await joinRunning();
    controller.startNextGeneration();
    pendingGenerationAdvance = false;
  }

  const completedOutcome = createCompletedRunOutcome(orderedTasks, outcomes);
  state.finish(completedOutcome);
  options.checkRunRecorder?.finish(completedOutcome);

  const orderedStartedIssues = orderedTasks.flatMap((task) => {
    const outcome = outcomes.get(task.id);
    if (
      !outcome ||
      (outcome.status !== 'passed' && outcome.status !== 'failed')
    ) {
      return [];
    }
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
  const sourceTask = orderedTasks.findLast(
    (task) => task.issueTask === 'source:check',
  );
  const selectedSourceOutcome = sourceTask
    ? outcomes.get(sourceTask.id)
    : undefined;
  const sourceOutcome =
    selectedSourceOutcome?.status === 'passed' ||
    selectedSourceOutcome?.status === 'failed'
      ? selectedSourceOutcome
      : undefined;
  const issues = sortCollectedIssues(orderedStartedIssues);

  await writeExecutionSnapshots({
    execution: options,
    finalRepositoryGeneration: controller.generation,
    issues,
    sourceOutcome,
    sourceTask,
    tasks: orderedTasks,
  });

  return {
    issues,
    outcome: completedOutcome,
    passed: completedOutcome.state === 'passed',
    results: orderedTasks.map((task) => {
      const outcome = outcomes.get(task.id)!;
      return {
        ...(outcome.status === 'passed' || outcome.status === 'failed'
          ? { durationMs: outcome.durationMs, issues: outcome.issues }
          : { issues: [] }),
        id: task.id,
        label: task.label,
        passed: outcome.status === 'passed',
        status: outcome.status,
      };
    }),
  };
}

export async function runExecutionTasks(
  options: RunExecutionTasksOptions,
): ReturnType<typeof runExecutionPlan> {
  return runExecutionPlan(
    { tasks: options.tasks, userTaskCount: options.tasks.length },
    options,
  );
}
