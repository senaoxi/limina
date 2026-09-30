import { plural } from '#utils/reporting';
import type { HumanPrimaryBlocker } from '../inventory-presentation';
import { type CheckIssueOverview, formatTopCounts } from './overview';

function pluralIssue(count: number): string {
  return plural(count, 'issue', 'issues');
}

function formatSeverityLabel(count: number, severity: string): string {
  return severity === 'info' ? 'info' : plural(count, severity, `${severity}s`);
}

export function formatSeverityTotal(overview: CheckIssueOverview): string {
  return overview.issueCount === 0
    ? '0 errors'
    : overview.severities
        .map(
          (entry) =>
            `${entry.count} ${formatSeverityLabel(entry.count, entry.name)}`,
        )
        .join(', ');
}

function formatVerboseChecker(blocker: HumanPrimaryBlocker): string[] {
  return blocker.checkerName === undefined
    ? []
    : [`   Checker: ${blocker.checkerName}`];
}

function formatVerboseTool(blocker: HumanPrimaryBlocker): string[] {
  return blocker.tool === undefined ? [] : [`   Tool: ${blocker.tool}`];
}

function formatVerboseBlockerLines(blocker: HumanPrimaryBlocker): string[] {
  return [
    `   Task: ${blocker.task}`,
    `   Severity: ${blocker.severity ?? 'error'}`,
    `   Affected files: ${blocker.affectedFiles}`,
    `   Affected packages: ${blocker.affectedPackages}`,
    `   Representative: ${blocker.representativeLocation ?? '(not recorded)'}`,
    ...formatVerboseChecker(blocker),
    ...formatVerboseTool(blocker),
  ];
}

function formatPackageLines(
  blocker: HumanPrimaryBlocker,
  isVerbose: boolean,
): string[] {
  if (blocker.packages.length === 0) return [];
  const limit = isVerbose ? blocker.packages.length : 5;
  return [`   Packages: ${formatTopCounts(blocker.packages, limit)}`];
}

function formatBlockerLines(options: {
  blocker: HumanPrimaryBlocker;
  index: number;
  verbose: boolean;
}): string[] {
  return [
    `${options.index + 1}. ${options.blocker.title}  ${
      options.blocker.count
    } ${pluralIssue(options.blocker.count)}`,
    `   Rule: ${options.blocker.code}`,
    `   ${options.blocker.summary}`,
    ...(options.verbose ? formatVerboseBlockerLines(options.blocker) : []),
    ...formatPackageLines(options.blocker, options.verbose),
  ];
}

export function formatHumanPrimaryBlockerLines(
  blockers: readonly HumanPrimaryBlocker[],
  isVerbose: boolean,
): string[] {
  return blockers.length === 0
    ? ['  (none)']
    : blockers.flatMap((blocker, index) =>
        formatBlockerLines({ blocker, index, verbose: isVerbose }),
      );
}
