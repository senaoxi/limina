import { normalizeSlashes } from '#utils/path';
import { plural } from '#utils/reporting';
import path from 'pathe';
import { generatedRootDirName } from '../../core/build-graph/generated/paths';
import type {
  CheckIssueSnapshot,
  LiminaCheckIssue,
  LiminaCheckRunSummary,
  LiminaCheckRunTaskSummary,
} from '../snapshot';

interface CheckRunExecutionStats {
  executed: number;
  notReached: number;
  planned: number;
  passed: number;
}

function formatLongDuration(durationMs: number): string {
  const precision = durationMs < 60_000 ? 1 : 0;
  return `${(durationMs / 1000).toFixed(precision)}s`;
}

export function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return '(not recorded)';
  if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))}ms`;
  return formatLongDuration(durationMs);
}

function formatRecordedConfigPath(
  configPath: string,
  rootDir: string | undefined,
): string {
  if (rootDir === undefined) return normalizeSlashes(configPath);
  if (!path.isAbsolute(configPath)) return normalizeSlashes(configPath);
  return normalizeSlashes(path.relative(rootDir, configPath));
}

export function formatConfigPath(
  run: LiminaCheckRunSummary | undefined,
  rootDir: string | undefined,
): string {
  const configPath = run?.configPath;
  if (configPath === undefined) return '(not recorded)';
  return formatRecordedConfigPath(configPath, rootDir);
}

export function formatSnapshotPath(rootDir: string | undefined): string {
  if (rootDir === undefined)
    return `${generatedRootDirName}/check/last-run.json`;
  const snapshotPath = path.join(
    rootDir,
    generatedRootDirName,
    'check',
    'last-run.json',
  );
  return normalizeSlashes(path.relative(rootDir, snapshotPath));
}

export function formatSnapshotTimestamp(snapshot: CheckIssueSnapshot): string {
  const timestamp = snapshot.run?.completedAt ?? snapshot.createdAt;
  return timestamp.replace('.000Z', 'Z');
}

export function formatCheckRunResult(run: LiminaCheckRunSummary): string {
  const results: Readonly<Record<string, string>> = {
    blocked: 'FAILED',
    failed: 'FAILED',
    passed: 'PASSED',
  };
  return results[run.result] ?? run.result.toUpperCase();
}

export function getCheckSummaryBorderColor(options: {
  issues: readonly LiminaCheckIssue[];
  run?: LiminaCheckRunSummary;
}): 'green' | 'red' {
  const passed = options.run
    ? formatCheckRunResult(options.run) === 'PASSED'
    : options.issues.length === 0;
  return passed ? 'green' : 'red';
}

function isVisibleExecutionTask(task: LiminaCheckRunTaskSummary): boolean {
  if (task.kind !== 'preparation') return true;
  return task.state !== 'passed';
}

function isExecutedTask(task: LiminaCheckRunTaskSummary): boolean {
  return ['disabled', 'failed', 'passed'].includes(task.state);
}

function isPassedTask(task: LiminaCheckRunTaskSummary): boolean {
  return task.state === 'passed';
}

function getEmptyExecutionStats(): CheckRunExecutionStats {
  return { executed: 0, notReached: 0, passed: 0, planned: 0 };
}

function getCheckRunExecutionStats(
  run: LiminaCheckRunSummary | undefined,
): CheckRunExecutionStats {
  if (run === undefined) return getEmptyExecutionStats();
  const visibleTasks = run.tasks.filter(isVisibleExecutionTask);
  const executed = visibleTasks.filter(isExecutedTask).length;
  return {
    executed,
    notReached: Math.max(0, visibleTasks.length - executed),
    passed: visibleTasks.filter(isPassedTask).length,
    planned: visibleTasks.length,
  };
}

function getBlockedTaskLabel(
  run: LiminaCheckRunSummary | undefined,
): string | undefined {
  if (run === undefined) return undefined;
  return run.blockedBy?.label;
}

function createNotReachedLine(label: string, count: number): string {
  return `Not reached after: ${label} (${count} ${plural(
    count,
    'task',
    'tasks',
  )})`;
}

function formatNotReachedLine(options: {
  notReached: number;
  run: LiminaCheckRunSummary | undefined;
}): string[] {
  if (options.notReached === 0) return [];
  const label = getBlockedTaskLabel(options.run);
  return label === undefined
    ? []
    : [createNotReachedLine(label, options.notReached)];
}

export function formatRunExecutionLines(options: {
  issueCount: number;
  run: LiminaCheckRunSummary | undefined;
}): string[] {
  const stats = getCheckRunExecutionStats(options.run);
  return [
    `Executed tasks: ${stats.executed} / ${stats.planned}`,
    `Passed tasks: ${stats.passed} / ${stats.executed}`,
    `Open issues: ${options.issueCount}`,
    ...formatNotReachedLine({
      notReached: stats.notReached,
      run: options.run,
    }),
  ];
}
