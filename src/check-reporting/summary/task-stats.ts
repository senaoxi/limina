import { colorText } from '#utils/reporting';
import type {
  LiminaCheckIssue,
  LiminaCheckRunCheckItemSummary,
  LiminaCheckRunSummary,
} from '../snapshot';
import { formatCheckCount } from './count-format';
import { formatDuration } from './run-metadata';
import {
  type CheckRunTaskExecutionStats,
  createTaskExecutionStats,
  getCheckItemTotal,
} from './task-aggregation';

const TASK_DISPLAY_LIMIT = 12;
const ANSI_GREEN = '\u001B[32m';
const ANSI_RED = '\u001B[31m';
const ANSI_YELLOW = '\u001B[33m';
const CHECK_STATS_LINE_PATTERN = /^(\s*)([✓✕◇]) (.*?)(\s{2}units\b.*)$/u;

function formatTaskStatsMarker(task: CheckRunTaskExecutionStats): string {
  return task.failed === 0 ? '✓' : '✕';
}

function formatTaskStatsLabel(task: CheckRunTaskExecutionStats): string {
  return `${formatTaskStatsMarker(task)} ${task.name}`;
}

function getFormattedDuration(
  durationMs: number | undefined,
): string | undefined {
  return durationMs === undefined ? undefined : formatDuration(durationMs);
}

function formatCheckStatsLine(options: {
  countWidth: number;
  durationMs?: number;
  issues: number;
  label: string;
  labelWidth: number;
  total: number;
}): string {
  const total = formatCheckCount(options.total);
  const issues = formatCheckCount(options.issues);
  return [
    options.label.padEnd(options.labelWidth),
    `units ${total.padStart(options.countWidth)}`,
    `issues ${issues.padStart(options.countWidth)}`,
    getFormattedDuration(options.durationMs),
  ]
    .filter(Boolean)
    .join('  ')
    .trimEnd();
}

function getItemMarker(item: LiminaCheckRunCheckItemSummary): string {
  const markers: Readonly<Record<string, string>> = {
    passed: '✓',
    skipped: '◇',
  };
  return markers[item.status] ?? '✕';
}

function formatCheckItemStatsLabel(
  item: LiminaCheckRunCheckItemSummary,
): string {
  return `  ${getItemMarker(item)} ${item.name}`;
}

function formatTaskStatsLine(options: {
  countWidth: number;
  labelWidth: number;
  task: CheckRunTaskExecutionStats;
}): string {
  return formatCheckStatsLine({
    countWidth: options.countWidth,
    durationMs: options.task.durationMs,
    issues: options.task.issues,
    label: formatTaskStatsLabel(options.task),
    labelWidth: options.labelWidth,
    total: options.task.total,
  });
}

function formatCheckItemStatsLine(options: {
  countWidth: number;
  item: LiminaCheckRunCheckItemSummary;
  labelWidth: number;
}): string {
  return formatCheckStatsLine({
    countWidth: options.countWidth,
    durationMs: options.item.durationMs,
    issues: options.item.issues ?? 0,
    label: formatCheckItemStatsLabel(options.item),
    labelWidth: options.labelWidth,
    total: getCheckItemTotal(options.item),
  });
}

function getLabelWidth(tasks: readonly CheckRunTaskExecutionStats[]): number {
  const lengths = tasks.flatMap((task) => [
    formatTaskStatsLabel(task).length,
    ...task.checkItems.map((item) => formatCheckItemStatsLabel(item).length),
  ]);
  return Math.max(22, ...lengths);
}

function getCountWidth(tasks: readonly CheckRunTaskExecutionStats[]): number {
  const lengths = tasks.flatMap((task) => [
    formatCheckCount(task.issues).length,
    formatCheckCount(task.total).length,
    ...task.checkItems.flatMap((item) => [
      formatCheckCount(item.issues ?? 0).length,
      formatCheckCount(getCheckItemTotal(item)).length,
    ]),
  ]);
  return Math.max(1, ...lengths);
}

function formatTaskLines(options: {
  countWidth: number;
  labelWidth: number;
  task: CheckRunTaskExecutionStats;
}): string[] {
  return [
    formatTaskStatsLine(options),
    ...options.task.checkItems.map((item) =>
      formatCheckItemStatsLine({ ...options, item }),
    ),
  ];
}

function formatRemainingTasks(count: number): string[] {
  return count === 0 ? [] : [`  ... ${count} more tasks`];
}

function getMarkerColor(marker: string): string {
  const colors: Readonly<Record<string, string>> = {
    '✓': ANSI_GREEN,
    '◇': ANSI_YELLOW,
  };
  return colors[marker] ?? ANSI_RED;
}

function getMatchPart(match: RegExpExecArray, index: number): string {
  return match[index] ?? '';
}

export function colorCheckStatsLine(line: string): string {
  const match = CHECK_STATS_LINE_PATTERN.exec(line);
  if (match === null) return line;
  const indent = getMatchPart(match, 1);
  const marker = getMatchPart(match, 2);
  const name = getMatchPart(match, 3);
  const rest = getMatchPart(match, 4);
  const checkName = name.trimEnd();
  const padding = name.slice(checkName.length);
  return `${indent}${colorText(
    getMarkerColor(marker),
    `${marker} ${checkName}`,
  )}${padding}${rest}`;
}

function hasRecordedTasks(
  run: LiminaCheckRunSummary | undefined,
): run is LiminaCheckRunSummary {
  if (run === undefined) return false;
  return run.tasks.length > 0;
}

function getVisibleStats(
  stats: readonly CheckRunTaskExecutionStats[],
  verbose: boolean,
): readonly CheckRunTaskExecutionStats[] {
  return verbose ? stats : stats.slice(0, TASK_DISPLAY_LIMIT);
}

function formatRecordedTaskStats(options: {
  issues: readonly LiminaCheckIssue[];
  run: LiminaCheckRunSummary;
  verbose: boolean;
}): string[] {
  const stats = createTaskExecutionStats(options.run, options.issues);
  if (stats.length === 0) return ['  (no units reached)'];
  const visible = getVisibleStats(stats, options.verbose);
  const layout = {
    countWidth: getCountWidth(visible),
    labelWidth: getLabelWidth(visible),
  };
  return [
    ...visible.flatMap((task) => formatTaskLines({ ...layout, task })),
    ...formatRemainingTasks(stats.length - visible.length),
  ];
}

export function formatTaskStatsLines(options: {
  issues: readonly LiminaCheckIssue[];
  run: LiminaCheckRunSummary | undefined;
  verbose: boolean;
}): string[] {
  if (!hasRecordedTasks(options.run)) return ['  (not recorded)'];
  return formatRecordedTaskStats({
    issues: options.issues,
    run: options.run,
    verbose: options.verbose,
  });
}
