import type {
  LiminaCheckIssue,
  LiminaCheckRunCheckItemSummary,
  LiminaCheckRunSummary,
  LiminaCheckRunTaskSummary,
} from '../snapshot';

export interface CheckRunTaskExecutionStats {
  checkItems: LiminaCheckRunCheckItemSummary[];
  durationMs?: number;
  failed: number;
  issues: number;
  kind: LiminaCheckRunTaskSummary['kind'];
  name: string;
  planned: number;
  reached: number;
  total: number;
}

function incrementCount(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function countIssuesByTask(
  issues: readonly LiminaCheckIssue[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const issue of issues) incrementCount(counts, issue.task);
  return counts;
}

function getTaskIssueKey(task: LiminaCheckRunTaskSummary): string {
  return task.kind === 'command' ? 'command' : task.issueTask;
}

function getTaskIssueCount(
  task: LiminaCheckRunTaskSummary,
  issueCounts: ReadonlyMap<string, number>,
): number {
  return issueCounts.get(getTaskIssueKey(task)) ?? 0;
}

export function getCheckItemTotal(
  item: LiminaCheckRunCheckItemSummary,
): number {
  return item.checksTotal ?? 1;
}

function getRecordedTaskTotal(task: LiminaCheckRunTaskSummary): number {
  return task.checksTotal ?? 1;
}

function sumCheckItemTotals(
  checkItems: readonly LiminaCheckRunCheckItemSummary[],
): number {
  return checkItems.reduce((total, item) => total + getCheckItemTotal(item), 0);
}

function getTaskTotal(task: LiminaCheckRunTaskSummary): number {
  const checkItems = task.checkItems ?? [];
  if (checkItems.length === 0) return getRecordedTaskTotal(task);
  return sumCheckItemTotals(checkItems);
}

function createTaskStat(
  task: LiminaCheckRunTaskSummary,
  issueCounts: ReadonlyMap<string, number>,
): CheckRunTaskExecutionStats {
  return {
    checkItems: [],
    failed: 0,
    issues: getTaskIssueCount(task, issueCounts),
    kind: task.kind,
    name: task.label,
    planned: 0,
    reached: 0,
    total: 0,
  };
}

function isVisibleTask(task: LiminaCheckRunTaskSummary): boolean {
  if (task.kind !== 'preparation') return true;
  return task.state !== 'passed';
}

function applyReachedTask(
  stat: CheckRunTaskExecutionStats,
  taskTotal: number,
): void {
  stat.reached += 1;
  stat.total += taskTotal;
}

function applyTaskState(
  stat: CheckRunTaskExecutionStats,
  task: LiminaCheckRunTaskSummary,
): void {
  if (task.state === 'passed') {
    applyReachedTask(stat, getTaskTotal(task));
    return;
  }
  if (task.state !== 'failed') return;
  stat.failed += 1;
  applyReachedTask(stat, getTaskTotal(task));
}

function appendCheckItems(
  stat: CheckRunTaskExecutionStats,
  task: LiminaCheckRunTaskSummary,
): void {
  if (task.checkItems !== undefined) stat.checkItems.push(...task.checkItems);
}

function appendTaskDuration(
  stat: CheckRunTaskExecutionStats,
  task: LiminaCheckRunTaskSummary,
): void {
  if (task.durationMs === undefined) return;
  stat.durationMs = (stat.durationMs ?? 0) + task.durationMs;
}

function updateTaskStat(
  stat: CheckRunTaskExecutionStats,
  task: LiminaCheckRunTaskSummary,
): void {
  stat.planned += 1;
  applyTaskState(stat, task);
  appendCheckItems(stat, task);
  appendTaskDuration(stat, task);
}

function getRunTasks(
  run: LiminaCheckRunSummary | undefined,
): readonly LiminaCheckRunTaskSummary[] {
  return run === undefined ? [] : run.tasks;
}

function getOrCreateStat(options: {
  issueCounts: ReadonlyMap<string, number>;
  stats: Map<string, CheckRunTaskExecutionStats>;
  task: LiminaCheckRunTaskSummary;
}): CheckRunTaskExecutionStats {
  const existing = options.stats.get(options.task.label);
  if (existing !== undefined) return existing;
  return createTaskStat(options.task, options.issueCounts);
}

export function createTaskExecutionStats(
  run: LiminaCheckRunSummary | undefined,
  issues: readonly LiminaCheckIssue[],
): CheckRunTaskExecutionStats[] {
  const tasks = getRunTasks(run);
  if (tasks.length === 0) return [];
  const issueCounts = countIssuesByTask(issues);
  const stats = new Map<string, CheckRunTaskExecutionStats>();
  for (const task of tasks.filter(isVisibleTask)) {
    const stat = getOrCreateStat({ issueCounts, stats, task });
    updateTaskStat(stat, task);
    stats.set(task.label, stat);
  }
  return [...stats.values()].filter((stat) => stat.reached > 0);
}
