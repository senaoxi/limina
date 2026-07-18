import { countDefinedBy } from '#utils/collections';
import {
  type LiminaCheckIssueRuleMetadata,
  listLiminaCheckIssueRuleMetadata,
} from './codes';
import type { CheckIssueSnapshot, LiminaCheckIssue } from './snapshot';

export type CheckIssueFilterHelpKind = 'checker' | 'package' | 'rule' | 'task';

const ANSI_RESET = '\u001B[0m';
const ANSI_BOLD = '\u001B[1m';
const ANSI_DIM = '\u001B[2m';
const ANSI_BLUE = '\u001B[34m';
const ANSI_CYAN = '\u001B[36m';
const ANSI_GREEN = '\u001B[32m';
const ANSI_YELLOW = '\u001B[33m';

interface CountEntry {
  count: number;
  name: string;
}

export interface CheckIssueFilterHelpValue {
  name: string;
}

function pluralIssue(count: number): string {
  return count === 1 ? 'issue' : 'issues';
}

function colorText(text: string, ...styles: readonly string[]): string {
  return `${styles.join('')}${text}${ANSI_RESET}`;
}

function formatTitle(title: string): string {
  return colorText(title, ANSI_BOLD, ANSI_CYAN);
}

function formatGroupName(name: string): string {
  return colorText(name, ANSI_BOLD, ANSI_BLUE);
}

function formatBullet(): string {
  return colorText('-', ANSI_DIM);
}

function formatRuleCode(code: string): string {
  return colorText(code, ANSI_YELLOW);
}

function formatFilterValue(value: string): string {
  return colorText(value, ANSI_CYAN);
}

function formatDescription(description: string): string {
  return colorText(description, ANSI_DIM);
}

function formatIssueCount(count: number): string {
  const text = `${count} ${pluralIssue(count)}`;

  return count > 0 ? colorText(text, ANSI_GREEN) : colorText(text, ANSI_DIM);
}

function formatNotice(message: string): string {
  return colorText(message, ANSI_YELLOW);
}

function formatCommand(command: string): string {
  return colorText(command, ANSI_CYAN);
}

function countBy(
  issues: readonly LiminaCheckIssue[],
  getValue: (issue: LiminaCheckIssue) => string | undefined,
): CountEntry[] {
  const counts = countDefinedBy(issues, getValue);

  return [...counts.entries()]
    .map(([name, count]) => ({ count, name }))
    .sort(
      (left, right) =>
        right.count - left.count || left.name.localeCompare(right.name),
    );
}

function groupRuleMetadataByTask(
  rules: readonly LiminaCheckIssueRuleMetadata[],
): Map<string, LiminaCheckIssueRuleMetadata[]> {
  const groups = new Map<string, LiminaCheckIssueRuleMetadata[]>();

  for (const rule of rules) {
    groups.set(rule.task, [...(groups.get(rule.task) ?? []), rule]);
  }

  return groups;
}

export function formatCheckIssueRuleHelp(): string {
  const groups = groupRuleMetadataByTask(listLiminaCheckIssueRuleMetadata());
  const lines = [formatTitle('Supported check issue rules:')];

  for (const [task, rules] of groups) {
    lines.push('', formatGroupName(task), '');

    for (const rule of rules) {
      lines.push(
        `${formatBullet()} ${formatRuleCode(rule.code)} ${formatDescription(rule.description)}`,
      );
    }
  }

  return lines.join('\n');
}

function formatCountHelp(options: {
  entries: readonly CountEntry[];
  helpKind: Exclude<CheckIssueFilterHelpKind, 'rule'>;
}): string {
  const labels = {
    checker: {
      empty: 'No checker filters are available.',
      title: 'Check issue checkers:',
    },
    package: {
      empty: 'No package filters are available.',
      title: 'Check issue packages:',
    },
    task: {
      empty: 'No task filters are available.',
      title: 'Check issue tasks:',
    },
  } as const;
  const label = labels[options.helpKind];

  return [
    formatTitle(label.title),
    '',
    ...(options.entries.length > 0
      ? options.entries.map(
          (entry) =>
            `${formatBullet()} ${formatFilterValue(entry.name)}  ${formatIssueCount(entry.count)}`,
        )
      : [formatNotice(label.empty)]),
  ].join('\n');
}

function mergeAvailableValuesWithIssueCounts(options: {
  availableValues?: readonly CheckIssueFilterHelpValue[];
  issueCounts: readonly CountEntry[];
}): CountEntry[] {
  const entries = new Map<string, CountEntry>();

  for (const value of options.availableValues ?? []) {
    const name = value.name.trim();

    if (name) {
      entries.set(name, { count: 0, name });
    }
  }

  for (const count of options.issueCounts) {
    entries.set(count.name, count);
  }

  return [...entries.values()].sort(
    (left, right) =>
      right.count - left.count || left.name.localeCompare(right.name),
  );
}

export function formatCheckIssueSnapshotFilterHelp(options: {
  availableValues?: readonly CheckIssueFilterHelpValue[];
  helpKind: Exclude<CheckIssueFilterHelpKind, 'rule'>;
  snapshot: CheckIssueSnapshot | null;
}): string {
  if (!options.snapshot) {
    if (options.availableValues?.length) {
      return formatCountHelp({
        entries: mergeAvailableValuesWithIssueCounts({
          availableValues: options.availableValues,
          issueCounts: [],
        }),
        helpKind: options.helpKind,
      });
    }

    return [
      formatNotice('No check issue snapshot found.'),
      `Run ${formatCommand('limina check')} first, then rerun this help command.`,
    ].join('\n');
  }

  if (options.snapshot.status !== 'completed') {
    if (options.availableValues?.length) {
      return [
        formatCountHelp({
          entries: mergeAvailableValuesWithIssueCounts({
            availableValues: options.availableValues,
            issueCounts: [],
          }),
          helpKind: options.helpKind,
        }),
        '',
        formatNotice(
          'No completed check issue snapshot is available from the last run, so issue counts are 0.',
        ),
      ].join('\n');
    }

    return [
      formatNotice(
        'No completed check issue snapshot is available from the last run.',
      ),
      `Run ${formatCommand('limina check')} and let it reach a failing or completed task first.`,
    ].join('\n');
  }

  const entries =
    options.helpKind === 'task'
      ? countBy(options.snapshot.issues, (issue) => issue.task)
      : options.helpKind === 'package'
        ? countBy(options.snapshot.issues, (issue) => issue.packageName)
        : countBy(options.snapshot.issues, (issue) => issue.checkerName);

  return formatCountHelp({
    entries: mergeAvailableValuesWithIssueCounts({
      availableValues: options.availableValues,
      issueCounts: entries,
    }),
    helpKind: options.helpKind,
  });
}
