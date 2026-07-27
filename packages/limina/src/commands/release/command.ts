import type { LiminaCheckIssue } from '../../check-reporting/snapshot';
import {
  createReleaseCommandContext,
  logReleaseCheckPlan,
  type ReleaseCommandContext,
} from './command-context';
import {
  handleFailedReleaseCheck,
  handlePassedReleaseCheck,
  handleReleaseCommandError,
  recordReleaseStats,
} from './command-result';
import { runReleaseCheckEntries } from './entry-pool';
import type {
  ReleaseCheckEntryRunResult,
  RunReleaseCheckOptions,
} from './types';

function collectEntryIssues(
  entryResults: readonly ReleaseCheckEntryRunResult[],
): LiminaCheckIssue[] {
  return entryResults.flatMap((result) => result.issues);
}

function appendInitialIssues(
  target: LiminaCheckIssue[] | undefined,
  issues: readonly LiminaCheckIssue[],
): void {
  if (target !== undefined) {
    target.push(...issues);
  }
}

function entriesPassed(
  entryResults: readonly ReleaseCheckEntryRunResult[],
): boolean {
  return entryResults.every((result) => result.passed);
}

export async function executeReleaseCommand(
  context: ReleaseCommandContext,
): Promise<boolean> {
  const plan = await context.preflight.ensurePackageEntrySelectionPlan({
    cwd: context.cwd,
    packageNames: context.options.packageNames,
    requireCwdPackageMatch: true,
  });
  logReleaseCheckPlan({
    config: context.options.config,
    cwd: context.cwd,
    plan,
  });
  const workspacePackages = await context.preflight.ensureWorkspacePackages();
  const entryResults = await runReleaseCheckEntries({
    entries: plan.entries,
    runOptions: context.options,
    workspacePackages,
  });
  const issues = collectEntryIssues(entryResults);
  appendInitialIssues(context.options.issues, issues);
  recordReleaseStats(context, entryResults);
  return entriesPassed(entryResults)
    ? handlePassedReleaseCheck(context)
    : handleFailedReleaseCheck(context, issues);
}

export async function runReleaseCheck(
  options: RunReleaseCheckOptions,
): Promise<boolean> {
  const context = createReleaseCommandContext(options);

  try {
    return await executeReleaseCommand(context);
  } catch (error) {
    return handleReleaseCommandError(context, error);
  }
}
