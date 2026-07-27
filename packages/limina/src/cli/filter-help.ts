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
  readCheckIssueSnapshot,
  readStandaloneIssueInvocation,
  toCheckIssueSnapshot,
} from '../check-reporting/snapshot';
import {
  parseCheckIssueFilterHelpKind,
  readArgvOptionValue,
  readGlobalFlagsFromArgv,
} from './argv';

type Snapshot = Awaited<ReturnType<typeof readCheckIssueSnapshot>>;

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
): Promise<Snapshot> {
  const globalFlags = readGlobalFlagsFromArgv(argv);
  const location = locateCheckIssueWorkspace({
    configPath: globalFlags.config,
  });
  const invocationId = readArgvOptionValue(argv, '--invocation');
  if (invocationId === undefined) {
    return readCheckIssueSnapshot(location.rootDir);
  }
  const invocation = await readStandaloneIssueInvocation(
    location.rootDir,
    invocationId,
  );
  return toCheckIssueSnapshot(invocation);
}

function printRuleHelp(): void {
  process.stdout.write(`${formatCheckIssueRuleHelp()}\n`);
}

async function printSnapshotHelp(options: {
  argv: readonly string[];
  helpKind: Exclude<CheckIssueFilterHelpKind, 'rule'>;
}): Promise<void> {
  const snapshot = await readRequestedSnapshot(options.argv);
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
