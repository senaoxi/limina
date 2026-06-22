import type {
  CheckRunRecorder,
  LiminaCheckRunTaskStats,
} from '../check-reporting/run-recorder';
import type { LiminaCheckIssue } from '../check-reporting/snapshot';
import {
  writeCompletedCheckIssueSnapshot,
  writeCompletedSourceIssueSnapshot,
} from '../check-reporting/snapshot';
import type { LiminaFlowReporter, LiminaFlowTreeNode } from '../flow';
import type { LiminaPreflightManager } from '../preflight';
import { resolveTaskConcurrency } from './config';
import { sortCollectedIssues } from './issues';
import { createTaskProgressReporter } from './progress';
import { ResourceLockSet } from './resources';
import type { ExecutionTask, ExecutionTaskResult } from './tasks';

export interface RunExecutionTasksOptions {
  checkRunRecorder?: CheckRunRecorder;
  command: string;
  flow?: LiminaFlowReporter;
  onTaskStats?: (
    task: ExecutionTask,
    stats: LiminaCheckRunTaskStats | undefined,
  ) => void;
  preflight: LiminaPreflightManager;
  rootDir: string;
  tasks: readonly ExecutionTask[];
}

interface RunningTask {
  promise: Promise<ExecutionTaskResult>;
  task: ExecutionTask;
}

function getReadyTasks(
  pending: readonly ExecutionTask[],
  completedTaskIds: Set<string>,
  blockedTaskIds: Set<string>,
  failedBlockingTaskIds: Set<string>,
): ExecutionTask[] {
  return pending.filter((task) => {
    const dependencies = task.deps ?? [];

    if (dependencies.some((dependency) => blockedTaskIds.has(dependency))) {
      return false;
    }

    if (
      dependencies.some((dependency) => failedBlockingTaskIds.has(dependency))
    ) {
      return false;
    }

    return dependencies.every((dependency) => completedTaskIds.has(dependency));
  });
}

function createBlockedTaskResult(options: {
  blockedBy: string;
  task: ExecutionTask;
}): ExecutionTaskResult {
  return {
    durationMs: 0,
    id: options.task.id,
    issues: [],
    name: options.task.name,
    passed: false,
    status: 'blocked',
  };
}

async function waitForAnyRunningTask(running: readonly RunningTask[]): Promise<{
  result: ExecutionTaskResult;
  task: ExecutionTask;
}> {
  return await Promise.race(
    running.map(async (runningTask) => ({
      result: await runningTask.promise,
      task: runningTask.task,
    })),
  );
}

function removeRunningTask(running: RunningTask[], taskId: string): void {
  const index = running.findIndex(
    (runningTask) => runningTask.task.id === taskId,
  );

  if (index !== -1) {
    running.splice(index, 1);
  }
}

function formatFlowTaskName(task: ExecutionTask): string {
  if (task.kind === 'command') {
    return `command: ${task.name}`;
  }

  return task.name.replaceAll(':', ' ');
}

export async function runExecutionTasks(
  options: RunExecutionTasksOptions,
): Promise<{
  issues: LiminaCheckIssue[];
  passed: boolean;
  results: ExecutionTaskResult[];
}> {
  const locks = new ResourceLockSet();
  const orderedTasks = [...options.tasks].sort(
    (left, right) => left.order - right.order,
  );
  const pending = [...orderedTasks];
  const running: RunningTask[] = [];
  const results: ExecutionTaskResult[] = [];
  const completedTaskIds = new Set<string>();
  const blockedTaskIds = new Set<string>();
  const failedBlockingTaskIds = new Set<string>();
  const blockedByTask = new Map<string, string>();
  const taskConcurrency = Math.max(
    1,
    resolveTaskConcurrency({
      config: options.preflight.config,
      itemCount: Math.max(1, options.tasks.length),
    }),
  );
  const flowNodes = new Map<string, LiminaFlowTreeNode>();
  const flowTaskNames = new Map<string, string>();

  for (const task of orderedTasks) {
    const flowTaskName = formatFlowTaskName(task);
    const node = options.flow?.tree(flowTaskName, { depth: 1 });

    flowTaskNames.set(task.id, flowTaskName);
    if (node) {
      flowNodes.set(task.id, node);
    }
  }

  function skipFlowTask(task: ExecutionTask, blockedBy: string): void {
    flowNodes
      .get(task.id)
      ?.skip(
        `${flowTaskNames.get(task.id) ?? task.name} (blocked by ${blockedBy})`,
        {
          depth: 1,
        },
      );
  }

  function markRemainingBlocked(blocker: ExecutionTask): void {
    for (const task of pending.splice(0)) {
      blockedTaskIds.add(task.id);
      blockedByTask.set(task.id, blocker.name);
      skipFlowTask(task, blocker.name);
      results.push(
        createBlockedTaskResult({
          blockedBy: blocker.name,
          task,
        }),
      );
    }
  }

  while (pending.length > 0 || running.length > 0) {
    const readyTasks = getReadyTasks(
      pending,
      completedTaskIds,
      blockedTaskIds,
      failedBlockingTaskIds,
    );
    let startedAnyTask = false;

    for (const task of readyTasks) {
      if (running.length >= taskConcurrency) {
        break;
      }

      if (!locks.canAcquire(task.resources)) {
        continue;
      }

      const pendingIndex = pending.findIndex(
        (pendingTask) => pendingTask.id === task.id,
      );

      if (pendingIndex === -1) {
        continue;
      }

      pending.splice(pendingIndex, 1);
      locks.acquire(task.id, task.resources);
      await options.checkRunRecorder?.start(task.name);
      const flowNode = flowNodes.get(task.id);

      flowNode?.start();
      running.push({
        promise: task.run({
          progress: createTaskProgressReporter(flowNode),
        }),
        task,
      });
      startedAnyTask = true;
    }

    if (running.length === 0) {
      const blockedTasks = pending.splice(0);
      const blocker = [...failedBlockingTaskIds][0] ?? 'dependency';

      for (const task of blockedTasks) {
        blockedTaskIds.add(task.id);
        blockedByTask.set(task.id, blocker);
        skipFlowTask(task, blocker);
        results.push(
          createBlockedTaskResult({
            blockedBy: blocker,
            task,
          }),
        );
      }
      break;
    }

    if (startedAnyTask && running.length < taskConcurrency) {
      continue;
    }

    const finished = await waitForAnyRunningTask(running);

    removeRunningTask(running, finished.task.id);
    locks.release(finished.task.id);
    results.push(finished.result);
    completedTaskIds.add(finished.task.id);
    options.onTaskStats?.(finished.task, finished.result.stats);

    const flowNode = flowNodes.get(finished.task.id);

    if (finished.result.passed) {
      flowNode?.pass(undefined, { elapsedTimeMs: finished.result.durationMs });
    } else {
      flowNode?.fail(undefined, { elapsedTimeMs: finished.result.durationMs });
    }

    if (finished.result.invalidatesPreflight) {
      options.preflight.invalidateAll();
    }

    if (finished.result.passed) {
      await options.checkRunRecorder?.pass(
        finished.task.name,
        finished.result.stats,
      );
      continue;
    }

    if (finished.task.failPolicy === 'block-remaining') {
      failedBlockingTaskIds.add(finished.task.id);
      await options.checkRunRecorder?.block(
        finished.task.name,
        `${finished.task.name} failed`,
        finished.result.stats,
      );
      markRemainingBlocked(finished.task);
      for (const runningTask of running.splice(0)) {
        locks.release(runningTask.task.id);
      }
      break;
    }

    await options.checkRunRecorder?.fail(
      finished.task.name,
      `${finished.task.name} failed`,
      finished.result.stats,
    );
  }

  for (const result of results.filter(
    (result) => result.status === 'blocked',
  )) {
    await options.checkRunRecorder?.skip(
      result.name,
      blockedByTask.get(result.id) ?? 'dependency',
    );
  }

  const orderedResults = results.toSorted((left, right) => {
    const leftOrder =
      options.tasks.find((task) => task.id === left.id)?.order ?? 0;
    const rightOrder =
      options.tasks.find((task) => task.id === right.id)?.order ?? 0;

    return leftOrder - rightOrder;
  });
  const issues = sortCollectedIssues(
    orderedResults.map((result) => ({
      issues: result.issues,
      taskId: result.id,
      taskOrder:
        options.tasks.find((task) => task.id === result.id)?.order ?? 0,
    })),
  );
  const passed = orderedResults.every((result) => result.passed);
  const finalStatus =
    blockedTaskIds.size > 0 ? 'blocked' : passed ? 'passed' : 'failed';

  await options.checkRunRecorder?.finish(finalStatus);
  await writeCompletedCheckIssueSnapshot({
    command: options.command,
    issues,
    rootDir: options.rootDir,
    run: options.checkRunRecorder?.getRunSummary(),
  });

  for (const result of orderedResults) {
    if (!result.sourceIssues && !result.sourceLegacyProblems) {
      continue;
    }

    await writeCompletedSourceIssueSnapshot({
      appendCheckIssues: false,
      command: options.command,
      issues: result.sourceIssues ?? [],
      legacyProblems: result.sourceLegacyProblems ?? [],
      rootDir: options.rootDir,
    });
  }

  return {
    issues,
    passed,
    results: orderedResults,
  };
}
