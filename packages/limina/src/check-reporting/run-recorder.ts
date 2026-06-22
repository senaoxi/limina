import {
  CHECK_ISSUE_SNAPSHOT_VERSION,
  type CheckIssueSnapshotStatus,
  type LiminaCheckRunCheckItemSummary,
  type LiminaCheckRunResult,
  type LiminaCheckRunSummary,
  type LiminaCheckRunTaskKind,
  type LiminaCheckRunTaskSummary,
  readCheckIssueSnapshot,
  writeCheckIssueSnapshot,
} from './snapshot';

export interface LiminaCheckRunTaskPlan {
  kind: LiminaCheckRunTaskKind;
  name: string;
}

export interface LiminaCheckRunTaskStats {
  items?: readonly LiminaCheckRunCheckItemSummary[];
  passed: number;
  total: number;
}

export interface CheckRunRecorder {
  block(
    taskName: string,
    reason?: string,
    stats?: LiminaCheckRunTaskStats,
  ): Promise<void>;
  fail(
    taskName: string,
    reason?: string,
    stats?: LiminaCheckRunTaskStats,
  ): Promise<void>;
  finish(
    result: Extract<LiminaCheckRunResult, 'blocked' | 'failed' | 'passed'>,
  ): Promise<void>;
  getRunSummary(): LiminaCheckRunSummary;
  pass(taskName: string, stats?: LiminaCheckRunTaskStats): Promise<void>;
  skip(taskName: string, blockedBy: string): Promise<void>;
  start(taskName: string): Promise<void>;
}

export interface CreateCheckRunRecorderOptions {
  command: string;
  configPath?: string;
  pipeline?: string;
  plannedTasks: readonly LiminaCheckRunTaskPlan[];
  rootDir: string;
}

function cloneRun(run: LiminaCheckRunSummary): LiminaCheckRunSummary {
  return {
    ...run,
    blockedBy: run.blockedBy ? { ...run.blockedBy } : undefined,
    tasks: run.tasks.map((task) => ({
      ...task,
      checkItems: task.checkItems
        ? task.checkItems.map((item) => ({ ...item }))
        : undefined,
    })),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function durationBetween(
  startedAt: string | undefined,
  completedAt: string,
): number | undefined {
  if (!startedAt) {
    return undefined;
  }

  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
}

function getFinalSnapshotStatus(
  result: LiminaCheckRunResult,
  currentStatus: CheckIssueSnapshotStatus | undefined,
): CheckIssueSnapshotStatus {
  if (result === 'blocked' || result === 'failed' || result === 'passed') {
    return 'completed';
  }

  return currentStatus ?? 'not-run';
}

function applyTaskStats(
  task: LiminaCheckRunTaskSummary,
  stats: LiminaCheckRunTaskStats | undefined,
): void {
  if (!stats) {
    return;
  }

  task.checksPassed = Math.max(0, stats.passed);
  task.checksTotal = Math.max(0, stats.total);
  task.checkItems = stats.items?.map((item) => ({
    checksPassed:
      item.checksPassed === undefined
        ? undefined
        : Math.max(0, item.checksPassed),
    checksTotal:
      item.checksTotal === undefined
        ? undefined
        : Math.max(0, item.checksTotal),
    durationMs:
      item.durationMs === undefined ? undefined : Math.max(0, item.durationMs),
    issues: item.issues === undefined ? undefined : Math.max(0, item.issues),
    name: item.name,
    status: item.status,
  }));
}

export function createCheckRunRecorder(
  options: CreateCheckRunRecorderOptions,
): CheckRunRecorder {
  const createdAt = nowIso();
  const run: LiminaCheckRunSummary = {
    command: options.command,
    configPath: options.configPath,
    createdAt,
    pipeline: options.pipeline,
    result: 'not-run',
    tasks: options.plannedTasks.map(
      (task): LiminaCheckRunTaskSummary => ({
        kind: task.kind,
        name: task.name,
        status: 'planned',
      }),
    ),
  };

  function findOrCreateTask(
    taskName: string,
    kind: LiminaCheckRunTaskKind = 'task',
  ): LiminaCheckRunTaskSummary {
    const existing = run.tasks.find((task) => task.name === taskName);

    if (existing) {
      return existing;
    }

    const task: LiminaCheckRunTaskSummary = {
      kind,
      name: taskName,
      status: 'planned',
    };

    run.tasks.push(task);

    return task;
  }

  async function persist(): Promise<void> {
    const current = await readCheckIssueSnapshot(options.rootDir);

    await writeCheckIssueSnapshot(options.rootDir, {
      command: current?.command ?? options.command,
      createdAt: current?.createdAt ?? createdAt,
      issues: current?.issues ?? [],
      run: cloneRun(run),
      status: getFinalSnapshotStatus(run.result, current?.status),
      version: CHECK_ISSUE_SNAPSHOT_VERSION,
    });
  }

  return {
    async block(taskName, reason, stats) {
      const completedAt = nowIso();
      const task = findOrCreateTask(taskName);

      task.completedAt = completedAt;
      task.durationMs = durationBetween(task.startedAt, completedAt);
      task.reason = reason;
      task.status = 'failed';
      applyTaskStats(task, stats);
      run.blockedBy = {
        reason,
        task: taskName,
      };
      run.completedAt = completedAt;
      run.durationMs = durationBetween(
        run.startedAt ?? run.createdAt,
        completedAt,
      );
      run.result = 'blocked';
      await persist();
    },
    async fail(taskName, reason, stats) {
      const completedAt = nowIso();
      const task = findOrCreateTask(taskName);

      task.completedAt = completedAt;
      task.durationMs = durationBetween(task.startedAt, completedAt);
      task.reason = reason;
      task.status = 'failed';
      applyTaskStats(task, stats);
      await persist();
    },
    async finish(result) {
      const completedAt = nowIso();

      run.completedAt = completedAt;
      run.durationMs = durationBetween(
        run.startedAt ?? run.createdAt,
        completedAt,
      );
      run.result = result;

      if (result === 'failed' || result === 'passed') {
        run.blockedBy = undefined;
      }

      await persist();
    },
    getRunSummary() {
      return cloneRun(run);
    },
    async pass(taskName, stats) {
      const completedAt = nowIso();
      const task = findOrCreateTask(taskName);

      task.completedAt = completedAt;
      task.durationMs = durationBetween(task.startedAt, completedAt);
      task.status = 'passed';
      applyTaskStats(task, stats);
      await persist();
    },
    async skip(taskName, blockedBy) {
      const task = findOrCreateTask(taskName);

      task.blockedBy = blockedBy;
      task.status = 'skipped';
      await persist();
    },
    async start(taskName) {
      const startedAt = nowIso();
      const task = findOrCreateTask(taskName);

      run.startedAt ??= startedAt;
      run.result = 'running';
      task.startedAt = startedAt;
      task.status = 'running';
      await persist();
    },
  };
}
