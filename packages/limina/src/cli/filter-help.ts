import { uniqueTrimmedNonEmptySortedStrings } from '#utils/collections';
import {
  type CheckIssueFilterHelpKind,
  type CheckIssueFilterHelpValue,
  formatCheckIssueRuleHelp,
  formatCheckIssueSnapshotFilterHelp,
} from '../check-reporting/filter-help';
import {
  LIMINA_CHECK_TASK_NAMES,
  locateCheckIssueWorkspace,
  type readCheckIssueSnapshot,
  readStandaloneIssueInvocation,
  toCheckIssueSnapshot,
} from '../check-reporting/snapshot';
import { queryLatestCheckAttempt } from '../source-check/snapshot/check-attempt-query';
import type { CheckAttemptQueryResult } from '../source-check/snapshot/check-attempt-query-types';
import {
  parseCheckIssueFilterHelpKind,
  readArgvOptionValue,
  readGlobalFlagsFromArgv,
} from './argv';

type Snapshot = Awaited<ReturnType<typeof readCheckIssueSnapshot>>;
interface RequestedSnapshot {
  attemptQuery?: CheckAttemptQueryResult;
  snapshot: Snapshot;
}

function uniqueSortedValues(
  values: readonly (string | undefined)[],
): CheckIssueFilterHelpValue[] {
  return uniqueTrimmedNonEmptySortedStrings(values).map((name) => ({ name }));
}

function getPackageValues(snapshot: Snapshot): CheckIssueFilterHelpValue[] {
  const values = snapshot?.issues.map((issue) => issue.packageName) ?? [];
  return uniqueSortedValues(values);
}

function getCheckerValues(snapshot: Snapshot): CheckIssueFilterHelpValue[] {
  const values = snapshot?.issues.map((issue) => issue.checkerName) ?? [];
  return uniqueSortedValues(values);
}

function getRunTaskNames(snapshot: Snapshot): string[] {
  if (snapshot === null) return [];
  if (snapshot.run === undefined) return [];
  return snapshot.run.tasks.map((task) => task.issueTask);
}

function getIssueTaskNames(snapshot: Snapshot): string[] {
  if (snapshot === null) return [];
  return snapshot.issues.map((issue) => issue.task);
}

function getTaskValues(snapshot: Snapshot): CheckIssueFilterHelpValue[] {
  return uniqueSortedValues([
    ...LIMINA_CHECK_TASK_NAMES,
    ...getRunTaskNames(snapshot),
    ...getIssueTaskNames(snapshot),
  ]);
}

function getFilterHelpValues(options: {
  helpKind: Exclude<CheckIssueFilterHelpKind, 'rule'>;
  snapshot: Snapshot;
}): CheckIssueFilterHelpValue[] {
  if (options.helpKind === 'task') return getTaskValues(options.snapshot);
  if (options.helpKind === 'checker') return getCheckerValues(options.snapshot);
  return getPackageValues(options.snapshot);
}

async function readRequestedSnapshot(
  argv: readonly string[],
): Promise<RequestedSnapshot> {
  const globalFlags = readGlobalFlagsFromArgv(argv);
  const location = locateCheckIssueWorkspace({
    configPath: globalFlags.config,
  });
  const invocationId = readArgvOptionValue(argv, '--invocation');
  if (invocationId === undefined) {
    const attemptQuery = await queryLatestCheckAttempt(location.rootDir);
    return { attemptQuery, snapshot: attemptQuery.snapshot };
  }
  const invocation = await readStandaloneIssueInvocation(
    location.rootDir,
    invocationId,
  );
  return { snapshot: toCheckIssueSnapshot(invocation) };
}

function isUnavailableAttemptQuery(
  query: CheckAttemptQueryResult | undefined,
): query is Extract<CheckAttemptQueryResult, { snapshot: null }> {
  if (query === undefined) return false;
  return query.state !== 'completed' && query.state !== 'legacy';
}

function printRuleHelp(): void {
  process.stdout.write(`${formatCheckIssueRuleHelp()}\n`);
}

async function printSnapshotHelp(options: {
  argv: readonly string[];
  helpKind: Exclude<CheckIssueFilterHelpKind, 'rule'>;
}): Promise<void> {
  const input = await readRequestedSnapshot(options.argv);
  if (isUnavailableAttemptQuery(input.attemptQuery)) {
    process.exitCode = 1;
    process.stdout.write(
      `Issue inventory unavailable: ${input.attemptQuery.message}\n`,
    );
    return;
  }
  const snapshot = input.snapshot;
  process.stdout.write(
    `${formatCheckIssueSnapshotFilterHelp({
      availableValues: getFilterHelpValues({
        helpKind: options.helpKind,
        snapshot,
      }),
      helpKind: options.helpKind,
      snapshot,
    })}\n`,
  );
}

export async function printCheckIssueFilterHelpIfRequested(
  argv: readonly string[],
): Promise<boolean> {
  const helpKind = parseCheckIssueFilterHelpKind(argv);
  if (helpKind === null) return false;
  if (helpKind === 'rule') {
    printRuleHelp();
    return true;
  }
  await printSnapshotHelp({ argv, helpKind });
  return true;
}
