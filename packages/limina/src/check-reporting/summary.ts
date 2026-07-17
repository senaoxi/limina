import { uniqueValues } from '#utils/collections';
import { normalizeSlashes } from '#utils/path';
import path from 'pathe';
import { generatedRootDirName } from '../core/build-graph/generated/paths';
import { formatCheckSummaryBlock } from '../reporting';
import {
  type CheckIssueInventoryPresentationOptions,
  compareCodeUnits,
  DEFAULT_PRIMARY_BLOCKER_LIMIT,
  DEFAULT_VISIBLE_ISSUE_LIMIT,
  formatInventoryQueryCommand,
  type HumanPrimaryBlocker,
  type InventoryQueryContext,
  selectHumanPrimaryBlockers,
} from './inventory-presentation';
import type {
  CheckIssueInventoryFilters,
  CheckIssueSnapshot,
  LiminaCheckIssue,
  LiminaCheckRunCheckItemSummary,
  LiminaCheckRunSummary,
  LiminaCheckRunTaskSummary,
} from './snapshot';

const TOP_BLOCKER_LIMIT = 5;
const TASK_DISPLAY_LIMIT = 12;
const ANSI_RESET = '\u001B[0m';
const ANSI_GREEN = '\u001B[32m';
const ANSI_RED = '\u001B[31m';
const ANSI_YELLOW = '\u001B[33m';
const CHECK_STATS_LINE_PATTERN = /^(\s*)([✓✕◇]) (.*?)(\s{2}units\b.*)$/u;

type AnsiColor = string;

export interface CountEntry {
  count: number;
  name: string;
}

export interface CheckIssueOverview {
  affectedFiles: number;
  affectedPackages: number;
  affectedScopes: number;
  checkers: CountEntry[];
  issueCount: number;
  packages: CountEntry[];
  rules: CountEntry[];
  scopes: CountEntry[];
  severities: CountEntry[];
  tasks: CountEntry[];
}

export interface CheckTopBlocker {
  affectedFiles: number;
  affectedPackages: number;
  code: string;
  count: number;
  packages: CountEntry[];
  severity?: string;
  summary?: string;
  task: string;
  title: string;
}

export interface CheckRunSummaryHumanOptions {
  issues: readonly LiminaCheckIssue[];
  queryContext?: InventoryQueryContext;
  rootDir?: string;
  run: LiminaCheckRunSummary;
  verbose?: boolean;
}

interface CheckIssueSnapshotSummaryHumanOptions {
  filteredIssueCount?: number;
  filters?: CheckIssueInventoryFilters;
  issues: readonly LiminaCheckIssue[];
  presentation: CheckIssueInventoryPresentationOptions;
  queryContext: InventoryQueryContext;
  rootDir?: string;
  snapshot: CheckIssueSnapshot;
  totalIssueCount?: number;
}

interface CheckRunExecutionStats {
  executed: number;
  notReached: number;
  planned: number;
  passed: number;
}

interface CheckRunTaskExecutionStats {
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

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

function pluralIssue(count: number): string {
  return plural(count, 'issue', 'issues');
}

function colorText(color: AnsiColor, text: string): string {
  return `${color}${text}${ANSI_RESET}`;
}

function incrementCount(counts: Map<string, number>, key: string | undefined) {
  if (!key) {
    return;
  }

  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function countBy(
  issues: readonly LiminaCheckIssue[],
  getValue: (issue: LiminaCheckIssue) => string | undefined,
): CountEntry[] {
  const counts = new Map<string, number>();

  for (const issue of issues) {
    incrementCount(counts, getValue(issue));
  }

  return [...counts.entries()]
    .map(([name, count]) => ({ count, name }))
    .sort(
      (left, right) =>
        right.count - left.count || left.name.localeCompare(right.name),
    );
}

function countByHuman(
  issues: readonly LiminaCheckIssue[],
  getValue: (issue: LiminaCheckIssue) => string | undefined,
): CountEntry[] {
  const counts = new Map<string, number>();

  for (const issue of issues) {
    incrementCount(counts, getValue(issue));
  }

  return [...counts.entries()]
    .map(([name, count]) => ({ count, name }))
    .sort(
      (left, right) =>
        right.count - left.count || compareCodeUnits(left.name, right.name),
    );
}

function getIssueFilePaths(issue: LiminaCheckIssue): string[] {
  return [
    issue.filePath,
    issue.packageManifestPath,
    ...(issue.locations ?? []).flatMap((location) => [
      location.filePath,
      location.packageManifestPath,
    ]),
  ].filter((value): value is string => Boolean(value));
}

function getIssueScope(issue: LiminaCheckIssue): string | undefined {
  if (issue.scope) {
    return issue.scope;
  }

  const filePath = getIssueFilePaths(issue)[0];

  if (!filePath) {
    return undefined;
  }

  const directory = path.posix.dirname(filePath);

  return directory === '.' ? '.' : directory;
}

function countUnique(
  issues: readonly LiminaCheckIssue[],
  getValues: (
    issue: LiminaCheckIssue,
  ) => string | readonly string[] | undefined,
): number {
  const values = new Set<string>();

  for (const issue of issues) {
    const value = getValues(issue);

    if (Array.isArray(value)) {
      for (const item of value) {
        values.add(item);
      }
      continue;
    }

    if (typeof value === 'string') {
      values.add(value);
    }
  }

  return values.size;
}

function formatTopCounts(
  entries: readonly CountEntry[],
  limit: number,
): string {
  if (entries.length === 0) {
    return '(none)';
  }

  return entries
    .slice(0, limit)
    .map((entry) => `${entry.name} (${entry.count})`)
    .join(', ');
}

function formatRankedCounts(
  entries: readonly CountEntry[],
  limit: number,
): string[] {
  if (entries.length === 0) {
    return ['  (none)'];
  }

  const visibleEntries = entries.slice(0, limit);
  const countWidth = Math.max(
    ...visibleEntries.map((entry) => String(entry.count).length),
  );

  return visibleEntries.map(
    (entry) => `  ${String(entry.count).padStart(countWidth)}  ${entry.name}`,
  );
}

function severityRank(severity: string | undefined): number {
  if (severity === 'error' || !severity) {
    return 3;
  }

  if (severity === 'warning') {
    return 2;
  }

  return 1;
}

function isStructuredGraphPrepareIssue(issue: LiminaCheckIssue): boolean {
  return issue.task === 'graph:prepare' && issue.detector === 'graph-prepare';
}

function getTopBlockerKey(issue: LiminaCheckIssue): string {
  if (isStructuredGraphPrepareIssue(issue)) {
    return `${issue.code}\0${issue.title}`;
  }

  return issue.code;
}

export function createIssueOverview(
  issues: readonly LiminaCheckIssue[],
): CheckIssueOverview {
  return {
    affectedFiles: countUnique(issues, getIssueFilePaths),
    affectedPackages: countUnique(issues, (issue) => issue.packageName),
    affectedScopes: countUnique(issues, getIssueScope),
    checkers: countBy(issues, (issue) => issue.checkerName),
    issueCount: issues.length,
    packages: countBy(issues, (issue) => issue.packageName),
    rules: countBy(issues, (issue) => issue.code),
    scopes: countBy(issues, getIssueScope),
    severities: countBy(issues, (issue) => issue.severity ?? 'error'),
    tasks: countBy(issues, (issue) => issue.task),
  };
}

function createHumanIssueOverview(
  issues: readonly LiminaCheckIssue[],
): CheckIssueOverview {
  return {
    affectedFiles: countUnique(issues, getIssueFilePaths),
    affectedPackages: countUnique(issues, (issue) => issue.packageName),
    affectedScopes: countUnique(issues, getIssueScope),
    checkers: countByHuman(issues, (issue) => issue.checkerName),
    issueCount: issues.length,
    packages: countByHuman(issues, (issue) => issue.packageName),
    rules: countByHuman(issues, (issue) => issue.code),
    scopes: countByHuman(issues, getIssueScope),
    severities: countByHuman(issues, (issue) => issue.severity ?? 'error'),
    tasks: countByHuman(issues, (issue) => issue.task),
  };
}

export function selectTopBlockers(
  issues: readonly LiminaCheckIssue[],
  limit: number = TOP_BLOCKER_LIMIT,
): CheckTopBlocker[] {
  const groups = new Map<string, CheckTopBlocker>();
  const filesByKey = new Map<string, Set<string>>();
  const packagesByKey = new Map<string, Map<string, number>>();

  for (const issue of issues) {
    const key = getTopBlockerKey(issue);
    const existing = groups.get(key);
    const files = filesByKey.get(key) ?? new Set<string>();
    const packages = packagesByKey.get(key) ?? new Map<string, number>();

    for (const filePath of getIssueFilePaths(issue)) {
      files.add(filePath);
    }

    if (issue.packageName) {
      incrementCount(packages, issue.packageName);
    }

    filesByKey.set(key, files);
    packagesByKey.set(key, packages);
    groups.set(key, {
      affectedFiles: files.size,
      affectedPackages: packages.size,
      code: issue.code,
      count: (existing?.count ?? 0) + 1,
      packages: [...packages.entries()]
        .map(([name, count]) => ({ count, name }))
        .sort(
          (left, right) =>
            right.count - left.count || left.name.localeCompare(right.name),
        ),
      severity: issue.severity,
      summary: existing?.summary ?? issue.summary ?? issue.reason,
      task: issue.task,
      title: issue.title,
    });
  }

  return [...groups.values()]
    .sort(
      (left, right) =>
        severityRank(right.severity) - severityRank(left.severity) ||
        right.count - left.count ||
        right.affectedPackages - left.affectedPackages ||
        right.affectedFiles - left.affectedFiles ||
        left.task.localeCompare(right.task) ||
        left.code.localeCompare(right.code) ||
        left.title.localeCompare(right.title),
    )
    .slice(0, limit);
}

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) {
    return '(not recorded)';
  }

  if (durationMs < 1000) {
    return `${Math.max(0, Math.round(durationMs))}ms`;
  }

  return `${(durationMs / 1000).toFixed(durationMs < 60_000 ? 1 : 0)}s`;
}

function formatConfigPath(
  run: LiminaCheckRunSummary | undefined,
  rootDir: string | undefined,
): string {
  if (!run?.configPath) {
    return '(not recorded)';
  }

  if (!rootDir || !path.isAbsolute(run.configPath)) {
    return normalizeSlashes(run.configPath);
  }

  return normalizeSlashes(path.relative(rootDir, run.configPath));
}

function formatSnapshotPath(rootDir: string | undefined): string {
  if (!rootDir) {
    return `${generatedRootDirName}/check/last-run.json`;
  }

  return normalizeSlashes(
    path.relative(
      rootDir,
      path.join(rootDir, generatedRootDirName, 'check', 'last-run.json'),
    ),
  );
}

function formatSnapshotTimestamp(snapshot: CheckIssueSnapshot): string {
  return (snapshot.run?.completedAt ?? snapshot.createdAt).replace(
    '.000Z',
    'Z',
  );
}

function formatCheckRunResult(run: LiminaCheckRunSummary): string {
  const result = run.result;

  if (result === 'passed') {
    return 'PASSED';
  }

  if (result === 'blocked' || result === 'failed') {
    return 'FAILED';
  }

  return result.toUpperCase();
}

function getCheckSummaryBorderColor(options: {
  issues: readonly LiminaCheckIssue[];
  run?: LiminaCheckRunSummary;
}): 'green' | 'red' {
  const passed = options.run
    ? formatCheckRunResult(options.run) === 'PASSED'
    : options.issues.length === 0;

  return passed ? 'green' : 'red';
}

function countIssuesByTask(
  issues: readonly LiminaCheckIssue[],
): Map<string, number> {
  const counts = new Map<string, number>();

  for (const issue of issues) {
    incrementCount(counts, issue.task);
  }

  return counts;
}

function getTaskIssueCount(
  task: LiminaCheckRunTaskSummary,
  issueCounts: ReadonlyMap<string, number>,
): number {
  if (task.kind === 'command') {
    return issueCounts.get('command') ?? 0;
  }

  return issueCounts.get(task.issueTask) ?? 0;
}

function isExecutedTask(task: LiminaCheckRunTaskSummary): boolean {
  return task.state === 'failed' || task.state === 'passed';
}

function getCheckRunExecutionStats(
  run: LiminaCheckRunSummary | undefined,
): CheckRunExecutionStats {
  if (!run) {
    return {
      executed: 0,
      notReached: 0,
      planned: 0,
      passed: 0,
    };
  }

  const visibleTasks = run.tasks.filter(
    (task) => task.kind !== 'preparation' || task.state !== 'passed',
  );
  const executed = visibleTasks.filter(isExecutedTask).length;
  const passed = visibleTasks.filter((task) => task.state === 'passed').length;

  return {
    executed,
    notReached: Math.max(0, visibleTasks.length - executed),
    planned: visibleTasks.length,
    passed,
  };
}

function createTaskExecutionStats(
  run: LiminaCheckRunSummary | undefined,
  issues: readonly LiminaCheckIssue[],
): CheckRunTaskExecutionStats[] {
  if (!run?.tasks.length) {
    return [];
  }

  const issueCounts = countIssuesByTask(issues);
  const stats = new Map<string, CheckRunTaskExecutionStats>();

  for (const task of run.tasks) {
    if (task.kind === 'preparation' && task.state === 'passed') {
      continue;
    }
    const checkItems = task.checkItems ?? [];
    const hasCheckItems = checkItems.length > 0;
    const itemTotal = hasCheckItems
      ? checkItems.reduce((total, item) => total + getCheckItemTotal(item), 0)
      : 0;
    const taskTotal = hasCheckItems ? itemTotal : (task.checksTotal ?? 1);
    const existing: CheckRunTaskExecutionStats = stats.get(task.label) ?? {
      checkItems: [],
      failed: 0,
      issues: getTaskIssueCount(task, issueCounts),
      kind: task.kind,
      name: task.label,
      planned: 0,
      reached: 0,
      total: 0,
    };

    existing.planned += 1;

    if (task.state === 'passed') {
      existing.reached += 1;
      existing.total += taskTotal;
    } else if (task.state === 'failed') {
      existing.failed += 1;
      existing.reached += 1;
      existing.total += taskTotal;
    }

    if (task.checkItems?.length) {
      existing.checkItems.push(...task.checkItems);
    }

    if (task.durationMs !== undefined) {
      existing.durationMs = (existing.durationMs ?? 0) + task.durationMs;
    }

    stats.set(task.label, existing);
  }

  return [...stats.values()].filter((stat) => stat.reached > 0);
}

const CHECK_COUNT_UNITS = ['', 'K', 'M', 'B', 'T', 'P', 'E'] as const;

function trimTrailingZeroes(value: string): string {
  if (!value.includes('.')) {
    return value;
  }

  let trimmed = value;

  while (trimmed.endsWith('0')) {
    trimmed = trimmed.slice(0, -1);
  }

  return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
}

function formatCheckCount(count: number): string {
  const value = Math.max(0, Math.round(count));

  if (value < 1000) {
    return String(value);
  }

  let unitIndex = 0;
  let scaled = value;

  while (scaled >= 1000 && unitIndex < CHECK_COUNT_UNITS.length - 1) {
    scaled /= 1000;
    unitIndex += 1;
  }

  const precision = scaled >= 100 ? 0 : 1;
  const rounded = Number(scaled.toFixed(precision));

  if (rounded >= 1000 && unitIndex < CHECK_COUNT_UNITS.length - 1) {
    return `${trimTrailingZeroes((rounded / 1000).toFixed(1))}${CHECK_COUNT_UNITS[unitIndex + 1]}`;
  }

  return `${trimTrailingZeroes(rounded.toFixed(precision))}${CHECK_COUNT_UNITS[unitIndex]}`;
}

function formatTaskStatsMarker(task: CheckRunTaskExecutionStats): string {
  return task.failed === 0 ? '✓' : '✕';
}

function formatTaskStatsLabel(task: CheckRunTaskExecutionStats): string {
  return `${formatTaskStatsMarker(task)} ${task.name}`;
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
    options.durationMs === undefined
      ? undefined
      : formatDuration(options.durationMs),
  ]
    .filter(Boolean)
    .join('  ')
    .trimEnd();
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

function getCheckItemTotal(item: LiminaCheckRunCheckItemSummary): number {
  return item.checksTotal ?? 1;
}

function formatCheckItemStatsMarker(
  item: LiminaCheckRunCheckItemSummary,
): string {
  if (item.status === 'passed') {
    return '✓';
  }

  if (item.status === 'skipped') {
    return '◇';
  }

  return '✕';
}

function formatCheckItemStatsLabel(
  item: LiminaCheckRunCheckItemSummary,
): string {
  return `  ${formatCheckItemStatsMarker(item)} ${item.name}`;
}

function colorCheckStatsLine(line: string): string {
  const match = CHECK_STATS_LINE_PATTERN.exec(line);

  if (!match) {
    return line;
  }

  const [, indent = '', marker = '', name = '', rest = ''] = match;
  const color =
    marker === '✓' ? ANSI_GREEN : marker === '◇' ? ANSI_YELLOW : ANSI_RED;
  const checkName = name.trimEnd();
  const padding = name.slice(checkName.length);

  return `${indent}${colorText(color, `${marker} ${checkName}`)}${padding}${rest}`;
}

function formatCheckItemStatsLine(options: {
  countWidth: number;
  item: LiminaCheckRunCheckItemSummary;
  labelWidth: number;
}): string {
  const total = getCheckItemTotal(options.item);
  const issues = options.item.issues ?? 0;

  return formatCheckStatsLine({
    countWidth: options.countWidth,
    durationMs: options.item.durationMs,
    issues,
    label: formatCheckItemStatsLabel(options.item),
    labelWidth: options.labelWidth,
    total,
  });
}

function formatCheckItemStatsLines(options: {
  countWidth: number;
  labelWidth: number;
  task: CheckRunTaskExecutionStats;
}): string[] {
  return options.task.checkItems.map((item) =>
    formatCheckItemStatsLine({
      countWidth: options.countWidth,
      item,
      labelWidth: options.labelWidth,
    }),
  );
}

function formatTaskStatsLines(
  run: LiminaCheckRunSummary | undefined,
  issues: readonly LiminaCheckIssue[],
  verbose: boolean,
): string[] {
  const stats = createTaskExecutionStats(run, issues);

  if (!run?.tasks.length) {
    return ['  (not recorded)'];
  }

  if (stats.length === 0) {
    return ['  (no units reached)'];
  }

  const visibleTasks = verbose ? stats : stats.slice(0, TASK_DISPLAY_LIMIT);
  const remainingTaskCount = stats.length - visibleTasks.length;
  const labelWidth = Math.max(
    22,
    ...visibleTasks.flatMap((task) =>
      [
        formatTaskStatsLabel(task),
        ...task.checkItems.map(formatCheckItemStatsLabel),
      ].map((label) => label.length),
    ),
  );
  const countWidth = Math.max(
    1,
    ...visibleTasks.flatMap((task) => [
      formatCheckCount(task.issues).length,
      formatCheckCount(task.total).length,
      ...task.checkItems.flatMap((item) => [
        formatCheckCount(item.issues ?? 0).length,
        formatCheckCount(getCheckItemTotal(item)).length,
      ]),
    ]),
  );

  return [
    ...visibleTasks.flatMap((task) => [
      formatTaskStatsLine({
        countWidth,
        labelWidth,
        task,
      }),
      ...formatCheckItemStatsLines({
        countWidth,
        labelWidth,
        task,
      }),
    ]),
    ...(remainingTaskCount > 0
      ? [`  ... ${remainingTaskCount} more tasks`]
      : []),
  ];
}

function formatRunExecutionLines(options: {
  issueCount: number;
  run: LiminaCheckRunSummary | undefined;
}): string[] {
  const stats = getCheckRunExecutionStats(options.run);

  return [
    `Executed tasks: ${stats.executed} / ${stats.planned}`,
    `Passed tasks: ${stats.passed} / ${stats.executed}`,
    `Open issues: ${options.issueCount}`,
    ...(stats.notReached > 0 && options.run?.blockedBy?.label
      ? [
          `Not reached after: ${options.run.blockedBy.label} (${stats.notReached} ${plural(
            stats.notReached,
            'task',
            'tasks',
          )})`,
        ]
      : []),
  ];
}

function hasFilters(filters: CheckIssueInventoryFilters | undefined): boolean {
  return Boolean(
    filters?.tasks?.length ||
      filters?.packageNames?.length ||
      filters?.rules?.length ||
      filters?.files?.length ||
      filters?.scopes?.length ||
      filters?.checkerNames?.length,
  );
}

function formatFilters(
  filters: CheckIssueInventoryFilters | undefined,
): string[] {
  if (!hasFilters(filters)) {
    return [];
  }

  return [
    'Filters:',
    ...(filters?.tasks?.length ? [`  task: ${filters.tasks.join(', ')}`] : []),
    ...(filters?.packageNames?.length
      ? [`  package: ${filters.packageNames.join(', ')}`]
      : []),
    ...(filters?.rules?.length ? [`  rule: ${filters.rules.join(', ')}`] : []),
    ...(filters?.files?.length ? [`  file: ${filters.files.join(', ')}`] : []),
    ...(filters?.scopes?.length
      ? [`  scope: ${filters.scopes.join(', ')}`]
      : []),
    ...(filters?.checkerNames?.length
      ? [`  checker: ${filters.checkerNames.join(', ')}`]
      : []),
  ];
}

function getEntryNames(entries: readonly CountEntry[]): ReadonlySet<string> {
  return new Set(entries.map((entry) => entry.name));
}

function findUnavailableFilterValues(
  selectedValues: readonly string[] | undefined,
  availableValues: ReadonlySet<string>,
): string[] {
  return (selectedValues ?? []).filter((value) => !availableValues.has(value));
}

function formatUnavailableFilterLines(options: {
  availableValues: ReadonlySet<string>;
  filterLabel: 'checker' | 'package' | 'task';
  helpCommand: string;
  selectedValues: readonly string[] | undefined;
}): string[] {
  return findUnavailableFilterValues(
    options.selectedValues,
    options.availableValues,
  ).flatMap((value) => [
    `  - ${options.filterLabel} "${value}" has no issues in the last snapshot.`,
    `    Help: ${options.helpCommand}`,
  ]);
}

function formatUnavailableRuleLines(options: {
  availableValues: ReadonlySet<string>;
  helpCommand: string;
  selectedValues: readonly string[] | undefined;
}): string[] {
  return findUnavailableFilterValues(
    options.selectedValues,
    options.availableValues,
  ).flatMap((value) => [
    `  - Supported rule "${value}" is absent from the last snapshot.`,
    `    Help: ${options.helpCommand}`,
  ]);
}

function formatFilterDiagnostics(options: {
  filters: CheckIssueInventoryFilters | undefined;
  queryContext: InventoryQueryContext;
  snapshot: CheckIssueSnapshot;
}): string[] {
  if (!hasFilters(options.filters)) {
    return [];
  }

  const overview = createHumanIssueOverview(options.snapshot.issues);
  const diagnostics = [
    ...formatUnavailableFilterLines({
      availableValues: getEntryNames(overview.tasks),
      filterLabel: 'task',
      helpCommand: formatInventoryQueryCommand(options.queryContext, {
        filterHelp: 'task',
      }),
      selectedValues: options.filters?.tasks,
    }),
    ...formatUnavailableFilterLines({
      availableValues: getEntryNames(overview.packages),
      filterLabel: 'package',
      helpCommand: formatInventoryQueryCommand(options.queryContext, {
        filterHelp: 'package',
      }),
      selectedValues: options.filters?.packageNames,
    }),
    ...formatUnavailableRuleLines({
      availableValues: getEntryNames(overview.rules),
      helpCommand: formatInventoryQueryCommand(options.queryContext, {
        filterHelp: 'rule',
      }),
      selectedValues: options.filters?.rules,
    }),
    ...formatUnavailableFilterLines({
      availableValues: getEntryNames(overview.checkers),
      filterLabel: 'checker',
      helpCommand: formatInventoryQueryCommand(options.queryContext, {
        filterHelp: 'checker',
      }),
      selectedValues: options.filters?.checkerNames,
    }),
  ];

  return diagnostics.length > 0 ? ['Filter diagnostics:', ...diagnostics] : [];
}

function formatSeverityLabel(count: number, severity: string): string {
  if (severity === 'info') {
    return 'info';
  }

  return plural(count, severity, `${severity}s`);
}

function formatSeverityTotal(overview: CheckIssueOverview): string {
  if (overview.issueCount === 0) {
    return '0 errors';
  }

  return overview.severities
    .map(
      (entry) =>
        `${entry.count} ${formatSeverityLabel(entry.count, entry.name)}`,
    )
    .join(', ');
}

function formatHumanPrimaryBlockerLines(
  blockers: readonly HumanPrimaryBlocker[],
  verbose: boolean,
): string[] {
  if (blockers.length === 0) {
    return ['  (none)'];
  }

  return blockers.flatMap((blocker, index) => [
    `${index + 1}. ${blocker.title}  ${blocker.count} ${pluralIssue(blocker.count)}`,
    `   Rule: ${blocker.code}`,
    `   ${blocker.summary}`,
    ...(verbose
      ? [
          `   Task: ${blocker.task}`,
          `   Severity: ${blocker.severity ?? 'error'}`,
          `   Affected files: ${blocker.affectedFiles}`,
          `   Affected packages: ${blocker.affectedPackages}`,
          `   Representative: ${blocker.representativeLocation ?? '(not recorded)'}`,
          ...(blocker.checkerName
            ? [`   Checker: ${blocker.checkerName}`]
            : []),
          ...(blocker.tool ? [`   Tool: ${blocker.tool}`] : []),
        ]
      : []),
    ...(blocker.packages.length > 0
      ? [
          `   Packages: ${formatTopCounts(
            blocker.packages,
            verbose ? blocker.packages.length : 5,
          )}`,
        ]
      : []),
  ]);
}

interface FailedTaskSelection {
  label: string;
  queryTask?: string;
}

function getFailedTask(
  run: LiminaCheckRunSummary | undefined,
): FailedTaskSelection | null {
  if (run?.blockedBy?.label) {
    const blockedTask = run.tasks.find(
      (task) =>
        task.id === run.blockedBy?.id || task.label === run.blockedBy?.label,
    );
    return {
      label: run.blockedBy.label,
      ...(blockedTask ? { queryTask: blockedTask.issueTask } : {}),
    };
  }

  const failedTasks =
    run?.tasks.filter((task) => task.state === 'failed') ?? [];
  const failedLabels = uniqueValues(failedTasks.map((task) => task.label));

  if (failedLabels.length !== 1) {
    return null;
  }

  const failedIssueTasks = uniqueValues(
    failedTasks.map((task) => task.issueTask),
  );

  return {
    label: failedLabels[0]!,
    ...(failedIssueTasks.length === 1
      ? { queryTask: failedIssueTasks[0] }
      : {}),
  };
}

interface NextCommandEntry {
  command: string;
  label: string;
}

function formatNextCommandEntries(
  entries: readonly NextCommandEntry[],
): string[] {
  const labelWidth = Math.max(
    ...entries.map((entry) => `${entry.label}:`.length),
  );

  return entries.map(
    (entry) => `${`${entry.label}:`.padEnd(labelWidth)} ${entry.command}`,
  );
}

function createDefaultInventoryQueryContext(): InventoryQueryContext {
  return {
    effectiveFormat: 'human',
    filters: {},
    global: {},
    limit: DEFAULT_VISIBLE_ISSUE_LIMIT,
    limitExplicit: false,
    verbose: false,
  };
}

function createCheckRunNextCommands(options: {
  failedTask: FailedTaskSelection | null;
  queryContext: InventoryQueryContext;
  topBlocker: HumanPrimaryBlocker | undefined;
}): NextCommandEntry[] {
  const taskFilters = options.failedTask?.queryTask
    ? [options.failedTask.queryTask]
    : undefined;

  return [
    {
      command: formatInventoryQueryCommand(options.queryContext, {
        additionalFilters: { tasks: taskFilters },
        limit: 'preserve',
        verbose: true,
      }),
      label: 'Verbose',
    },
    ...(options.topBlocker
      ? [
          {
            command: formatInventoryQueryCommand(options.queryContext, {
              additionalFilters: { rules: [options.topBlocker.code] },
              limit: 'preserve',
              verbose: true,
            }),
            label: 'By rule',
          },
        ]
      : []),
    {
      command: formatInventoryQueryCommand(options.queryContext, {
        format: 'json',
      }),
      label: 'JSON',
    },
  ];
}

export function formatCheckRunSummaryHuman(
  options: CheckRunSummaryHumanOptions,
): string {
  const verbose = options.verbose ?? false;
  const overview = createHumanIssueOverview(options.issues);
  const primaryBlockers = selectHumanPrimaryBlockers(
    options.issues,
    verbose ? options.issues.length : DEFAULT_PRIMARY_BLOCKER_LIMIT,
  );
  const run = options.run;
  const failedTask = getFailedTask(run);
  const result = formatCheckRunResult(run);
  const queryContext =
    options.queryContext ?? createDefaultInventoryQueryContext();
  const nextCommands = createCheckRunNextCommands({
    failedTask,
    queryContext,
    topBlocker: primaryBlockers[0],
  });
  const hasIssues = overview.issueCount > 0;
  const shouldShowFailureSections = result !== 'PASSED';
  const shouldShowBlockedAt =
    run?.result === 'blocked' || Boolean(run?.blockedBy);

  return formatCheckSummaryBlock({
    borderColor: getCheckSummaryBorderColor({
      issues: options.issues,
      run,
    }),
    colorLine: colorCheckStatsLine,
    lines: [
      `Command: ${run.command}`,
      `Config: ${formatConfigPath(run, options.rootDir)}`,
      `Duration: ${formatDuration(run?.durationMs)}`,
      ...formatRunExecutionLines({
        issueCount: overview.issueCount,
        run,
      }),
      ...(shouldShowFailureSections || verbose
        ? [
            ...(shouldShowBlockedAt
              ? [
                  `Blocked at: ${
                    run?.blockedBy?.label ?? failedTask?.label ?? '(none)'
                  }`,
                ]
              : []),
            `Snapshot: ${formatSnapshotPath(options.rootDir)}`,
          ]
        : []),
      'Validation units:',
      ...formatTaskStatsLines(run, options.issues, verbose),
      ...(hasIssues
        ? [
            'Issue overview:',
            `Total: ${formatSeverityTotal(overview)}`,
            `Affected packages: ${overview.affectedPackages}`,
            `Affected scopes: ${overview.affectedScopes}`,
            ...(verbose
              ? [
                  'Package counts:',
                  ...formatRankedCounts(
                    overview.packages,
                    overview.packages.length,
                  ),
                ]
              : []),
            'Top rules:',
            ...formatRankedCounts(
              overview.rules,
              verbose ? overview.rules.length : 5,
            ),
            'Primary blockers:',
            ...formatHumanPrimaryBlockerLines(primaryBlockers, verbose),
            'Next commands:',
            ...formatNextCommandEntries(nextCommands),
          ]
        : []),
    ],
    title: 'Limina check summary',
  }).join('\n');
}

function createIssueSnapshotNextCommands(options: {
  presentation: CheckIssueInventoryPresentationOptions;
  primaryBlocker: HumanPrimaryBlocker | undefined;
  queryContext: InventoryQueryContext;
}): NextCommandEntry[] {
  const entries: NextCommandEntry[] = [];

  if (options.presentation.view === 'summary') {
    entries.push({
      command: formatInventoryQueryCommand(options.queryContext, {
        limit: options.presentation.maxIssues ?? 'all',
      }),
      label: 'Show issues',
    });
  }

  if (options.primaryBlocker) {
    entries.push({
      command: formatInventoryQueryCommand(options.queryContext, {
        additionalFilters: {
          rules: [options.primaryBlocker.code],
          tasks: [options.primaryBlocker.task],
        },
        limit: 'preserve',
        verbose: options.queryContext.verbose,
      }),
      label: 'Refine',
    });
  }

  if (options.presentation.view !== 'detailed') {
    entries.push({
      command: formatInventoryQueryCommand(options.queryContext, {
        limit: 'preserve',
        verbose: true,
      }),
      label: 'Detailed',
    });
  }

  entries.push(
    {
      command: formatInventoryQueryCommand(options.queryContext, {
        limit: 'all',
        verbose: options.queryContext.verbose,
      }),
      label: 'Complete',
    },
    {
      command: formatInventoryQueryCommand(options.queryContext, {
        format: 'json',
      }),
      label: 'JSON',
    },
  );

  return entries;
}

export function formatCheckIssueSnapshotSummaryHuman(
  options: CheckIssueSnapshotSummaryHumanOptions,
): string {
  const overview = createHumanIssueOverview(options.issues);
  const primaryBlockers = selectHumanPrimaryBlockers(
    options.issues,
    options.presentation.maxPrimaryBlockers,
  );
  const filteredIssueCount =
    options.filteredIssueCount ?? options.issues.length;
  const totalIssueCount = options.totalIssueCount ?? options.issues.length;
  const nextCommands = createIssueSnapshotNextCommands({
    presentation: options.presentation,
    primaryBlocker: primaryBlockers[0],
    queryContext: options.queryContext,
  });

  return formatCheckSummaryBlock({
    borderColor: getCheckSummaryBorderColor({
      issues: options.snapshot.issues,
      run: options.snapshot.run,
    }),
    lines: [
      `Snapshot: ${formatSnapshotTimestamp(options.snapshot)}`,
      `Command: ${options.snapshot.run?.command ?? options.snapshot.command}`,
      `Status: ${options.snapshot.status}`,
      `Matched: ${filteredIssueCount} / ${totalIssueCount} issues`,
      ...formatFilters(options.filters),
      ...formatFilterDiagnostics({
        filters: options.filters,
        queryContext: options.queryContext,
        snapshot: options.snapshot,
      }),
      'Issue overview:',
      `Tasks: ${formatTopCounts(overview.tasks, 5)}`,
      `Packages: ${formatTopCounts(overview.packages, 5)}`,
      'Top rules:',
      ...formatRankedCounts(overview.rules, 5),
      'Primary blockers:',
      ...formatHumanPrimaryBlockerLines(primaryBlockers, false),
      'Next commands:',
      ...formatNextCommandEntries(nextCommands),
    ],
    title: 'Limina check issue summary',
  }).join('\n');
}
