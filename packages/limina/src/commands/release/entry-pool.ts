import type { WorkspacePackage } from '#core/workspace/actions';
import {
  createTaskFailureIssue,
  type LiminaCheckIssue,
} from '../../check-reporting/snapshot';
import { resolveReleaseEntryConcurrency } from '../../execution/config';
import { runPool } from '../../execution/pool';
import type { TaskProgressItem } from '../../execution/progress';
import { formatErrorMessage } from '../../logger';
import { runReleaseCheckEntry } from './entry';
import type {
  ReleaseCheckEntryRunResult,
  ReleasePlanEntry,
  RunReleaseCheckOptions,
} from './types';

function createReleaseProgressItems(
  entries: readonly ReleasePlanEntry[],
  options: RunReleaseCheckOptions,
): Map<string, TaskProgressItem | undefined> {
  return new Map(
    entries.map((entry) => [
      entry.label,
      options.progress?.planItem(entry.label),
    ]),
  );
}

function passProgressItem(
  progressItem: TaskProgressItem | undefined,
  elapsedTimeMs: number,
): void {
  progressItem?.pass(undefined, { elapsedTimeMs });
}

function failProgressItem(
  progressItem: TaskProgressItem | undefined,
  elapsedTimeMs: number,
): void {
  progressItem?.fail(undefined, { elapsedTimeMs });
}

function finishReleaseProgressItem(
  progressItem: TaskProgressItem | undefined,
  result: ReleaseCheckEntryRunResult,
): void {
  if (result.passed) {
    passProgressItem(progressItem, result.durationMs);
    return;
  }

  failProgressItem(progressItem, result.durationMs);
}

function createEntryInfrastructureIssue(options: {
  entry: ReleasePlanEntry;
  error: unknown;
  runOptions: RunReleaseCheckOptions;
}): LiminaCheckIssue {
  const errorMessage = formatErrorMessage(options.error);
  return createTaskFailureIssue({
    code: 'LIMINA_RELEASE_CHECK_FAILED',
    detailLines: [errorMessage],
    filePath: options.runOptions.config.configPath,
    fix: 'Inspect the release check error above, then rerun `limina release check`.',
    packageName: options.entry.label,
    reason: `Release check failed: ${errorMessage}.`,
    rootDir: options.runOptions.config.rootDir,
    task: 'release:check',
    title: 'Release check failed',
    tool: 'release',
  });
}

function createEntryErrorResult(options: {
  entry: ReleasePlanEntry;
  error: unknown;
  runOptions: RunReleaseCheckOptions;
}): ReleaseCheckEntryRunResult {
  return {
    durationMs: 0,
    issues: [createEntryInfrastructureIssue(options)],
    label: options.entry.label,
    passed: false,
  };
}

async function executePoolEntry(options: {
  entry: ReleasePlanEntry;
  progressItem: TaskProgressItem | undefined;
  runOptions: RunReleaseCheckOptions;
  workspacePackages: readonly WorkspacePackage[];
}): Promise<ReleaseCheckEntryRunResult> {
  const issues: LiminaCheckIssue[] = [];
  const startedAt = performance.now();
  const passed = await runReleaseCheckEntry({
    config: options.runOptions.config,
    flow: options.runOptions.flow,
    flowDepth: options.runOptions.flowDepth,
    issueSink: issues,
    label: options.entry.label,
    outDir: options.entry.outDir,
    progressItem: options.progressItem,
    workspacePackages: options.workspacePackages,
  });
  return {
    durationMs: performance.now() - startedAt,
    issues,
    label: options.entry.label,
    passed,
  };
}

export async function runReleaseCheckEntries(options: {
  entries: readonly ReleasePlanEntry[];
  runOptions: RunReleaseCheckOptions;
  workspacePackages: readonly WorkspacePackage[];
}): Promise<ReleaseCheckEntryRunResult[]> {
  if (options.entries.length === 0) {
    return [];
  }

  const progressItems = createReleaseProgressItems(
    options.entries,
    options.runOptions,
  );
  return runPool({
    concurrency: resolveReleaseEntryConcurrency({
      config: options.runOptions.config,
      itemCount: options.entries.length,
    }),
    items: options.entries,
    onError: (entry, error) =>
      createEntryErrorResult({ entry, error, runOptions: options.runOptions }),
    onResult: (entry, result) =>
      finishReleaseProgressItem(progressItems.get(entry.label), result),
    onStart: (entry) => progressItems.get(entry.label)?.start(),
    run: (entry) =>
      executePoolEntry({
        entry,
        progressItem: progressItems.get(entry.label),
        runOptions: options.runOptions,
        workspacePackages: options.workspacePackages,
      }),
  });
}
