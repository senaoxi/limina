import path from 'pathe';
import type { LiminaCheckRunCheckItemSummary } from '../check-reporting/snapshot';
import { createTaskFailureIssue } from '../check-reporting/snapshot';
import {
  createCheckItemStats,
  createSkippedCheckItemStats,
} from '../check-reporting/stats';
import { resolvePackageEntryConcurrency } from '../execution/config';
import { runPool } from '../execution/pool';
import type { TaskProgressItem } from '../execution/progress';
import { formatErrorMessage } from '../logger';
import { resolvePreflight } from '../preflight';
import { runPackageCheckEntry } from './entry/runner';
import type { PackageEntrySelectionPlan } from './entry/selection';
import type {
  PackageCheckEntryRunResult,
  RunPackageCheckOptions,
} from './runner-types';
import { logPackageCheckPlan } from './tool-config';

type RunnableEntry = PackageEntrySelectionPlan['entries'][number];

function getRunnableEntries(plan: PackageEntrySelectionPlan): RunnableEntry[] {
  return plan.entries.filter((entry) => entry.checks.length > 0);
}

function createNoChecksError(options: RunPackageCheckOptions): Error {
  if (options.tool !== undefined && options.tool !== 'all') {
    return new Error(`No package entries have "${options.tool}" enabled.`);
  }
  return new Error('No package checks are enabled.');
}

function createProgressItems(options: {
  entries: readonly RunnableEntry[];
  runOptions: RunPackageCheckOptions;
}): Map<string, TaskProgressItem | undefined> {
  return new Map(
    options.entries.map((entry) => [
      entry.label,
      options.runOptions.progress?.planItem(
        `${entry.label} (${entry.checks.join(', ')})`,
      ),
    ]),
  );
}

function createEntryFailure(options: {
  entry: RunnableEntry;
  error: unknown;
  runOptions: RunPackageCheckOptions;
}): PackageCheckEntryRunResult {
  const message = formatErrorMessage(options.error);
  return {
    checkedToolCount: options.entry.checks.length,
    durationMs: 0,
    issues: [
      createTaskFailureIssue({
        code: 'LIMINA_PACKAGE_CHECK_FAILED',
        detailLines: [message],
        filePath: options.runOptions.config.configPath,
        fix: 'Inspect the package check error above, then rerun `limina package check`.',
        packageName: options.entry.label,
        reason: `Package check failed: ${message}.`,
        rootDir: options.runOptions.config.rootDir,
        task: 'package:check',
        title: 'Package check failed',
        tool: 'package',
      }),
    ],
    label: options.entry.label,
    passed: false,
    skippedToolCount: 0,
  };
}

function passProgressItem(
  item: TaskProgressItem | undefined,
  elapsedTimeMs: number,
): void {
  if (item !== undefined) item.pass(undefined, { elapsedTimeMs });
}

function failProgressItem(
  item: TaskProgressItem | undefined,
  elapsedTimeMs: number,
): void {
  if (item !== undefined) item.fail(undefined, { elapsedTimeMs });
}

function finishProgressItem(options: {
  progressItem: TaskProgressItem | undefined;
  result: PackageCheckEntryRunResult;
}): void {
  const finish = options.result.passed ? passProgressItem : failProgressItem;
  finish(options.progressItem, options.result.durationMs);
}

async function runEntry(options: {
  entry: RunnableEntry;
  progressItems: ReadonlyMap<string, TaskProgressItem | undefined>;
  runOptions: RunPackageCheckOptions;
}): Promise<PackageCheckEntryRunResult> {
  const issues: PackageCheckEntryRunResult['issues'] = [];
  const startedAt = performance.now();
  const result = await runPackageCheckEntry({
    attwProfile: options.runOptions.attwProfile,
    checks: options.entry.checks,
    config: options.runOptions.config,
    flow: options.runOptions.flow,
    flowDepth: (options.runOptions.flowDepth ?? 0) + 1,
    issueSink: issues,
    label: options.entry.label,
    outDir: options.entry.outDir,
    progressItem: options.progressItems.get(options.entry.label),
    rawEntry: options.entry.rawEntry,
  });
  return {
    ...result,
    durationMs: performance.now() - startedAt,
    issues,
    label: `${options.entry.label} (${options.entry.checks.join(', ')})`,
  };
}

async function runEntries(options: {
  entries: readonly RunnableEntry[];
  progressItems: ReadonlyMap<string, TaskProgressItem | undefined>;
  runOptions: RunPackageCheckOptions;
}): Promise<PackageCheckEntryRunResult[]> {
  return runPool({
    concurrency: resolvePackageEntryConcurrency({
      config: options.runOptions.config,
      itemCount: options.entries.length,
    }),
    items: options.entries,
    onError: (entry, error) =>
      createEntryFailure({ entry, error, runOptions: options.runOptions }),
    onResult: (entry, result) =>
      finishProgressItem({
        progressItem: options.progressItems.get(entry.label),
        result,
      }),
    onStart: (entry) => options.progressItems.get(entry.label)?.start(),
    run: (entry) => runEntry({ ...options, entry }),
  });
}

function isOnlySkipped(result: PackageCheckEntryRunResult): boolean {
  if (!result.passed) return false;
  if (result.checkedToolCount !== 0) return false;
  return result.skippedToolCount > 0;
}

function createSkippedItem(
  result: PackageCheckEntryRunResult,
): LiminaCheckRunCheckItemSummary {
  return createSkippedCheckItemStats({
    durationMs: result.durationMs,
    name: result.label,
  });
}

function createExecutedItem(
  result: PackageCheckEntryRunResult,
): LiminaCheckRunCheckItemSummary {
  const issues = result.passed ? 0 : Math.max(1, result.issues.length);
  return createCheckItemStats({
    durationMs: result.durationMs,
    issues,
    name: result.label,
    total: result.checkedToolCount,
  });
}

function createCheckItem(
  result: PackageCheckEntryRunResult,
): LiminaCheckRunCheckItemSummary {
  return isOnlySkipped(result)
    ? createSkippedItem(result)
    : createExecutedItem(result);
}

function sumCheckItemField(
  items: readonly LiminaCheckRunCheckItemSummary[],
  field: 'checksPassed' | 'checksTotal',
): number {
  return items.reduce((total, item) => total + (item[field] ?? 0), 0);
}

function reportResults(options: {
  entryResults: PackageCheckEntryRunResult[];
  runOptions: RunPackageCheckOptions;
}): boolean {
  const checkItems = options.entryResults.map(createCheckItem);
  options.runOptions.issues?.push(
    ...options.entryResults.flatMap((result) => result.issues),
  );
  options.runOptions.onStats?.({
    items: checkItems,
    passed: sumCheckItemField(checkItems, 'checksPassed'),
    total: sumCheckItemField(checkItems, 'checksTotal'),
  });
  return options.entryResults.every((result) => result.passed);
}

export async function runPackageCheckImpl(
  options: RunPackageCheckOptions,
): Promise<boolean> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const preflight = resolvePreflight(options.config, options);
  const plan = await preflight.ensurePackageEntrySelectionPlan({
    cwd,
    packageNames: options.packageNames,
    requireCwdPackageMatch: false,
    tool: options.tool,
  });
  logPackageCheckPlan({ config: options.config, cwd, plan });
  const entries = getRunnableEntries(plan);
  if (entries.length === 0) throw createNoChecksError(options);
  const progressItems = createProgressItems({ entries, runOptions: options });
  const entryResults = await runEntries({
    entries,
    progressItems,
    runOptions: options,
  });
  return reportResults({ entryResults, runOptions: options });
}
