import type { ResolvedLiminaConfig } from '#config/runner';
import { uniqueSortedStrings } from '#utils/collections';
import { normalizeSlashes, toRelativePath } from '#utils/path';
import boxen from 'boxen';
import path from 'pathe';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import {
  pathCandidatesMatchFileFilters,
  pathCandidatesMatchScopeFilters,
  type PathFilterCandidate,
} from '../check-reporting/path-filters';
import { formatShellCommand } from '../check-reporting/shell-command';
import type {
  LiminaCheckIssueEvidence,
  LiminaCheckIssueLocation,
} from '../check-reporting/snapshot';
import { formatCheckSummaryBlock } from '../reporting';

export const SOURCE_ISSUE_CODES: {
  readonly unusedModule: typeof LIMINA_CHECK_ISSUE_CODES.sourceUnusedModule;
  readonly unusedWorkspaceDependency: typeof LIMINA_CHECK_ISSUE_CODES.sourceUnusedWorkspaceDependency;
} = {
  unusedModule: LIMINA_CHECK_ISSUE_CODES.sourceUnusedModule,
  unusedWorkspaceDependency:
    LIMINA_CHECK_ISSUE_CODES.sourceUnusedWorkspaceDependency,
};

export type SourceIssueCode = string;

export interface SourceIssueReportOptions {
  command?: string;
  defer?: boolean;
  files?: readonly string[];
  packageNames?: readonly string[];
  rules?: readonly string[];
  scopes?: readonly string[];
  verbose?: boolean;
}

export interface SourceUnusedModuleIssue {
  code: typeof SOURCE_ISSUE_CODES.unusedModule;
  filePath: string;
  ownerDirectory: string;
  ownerName: string;
  packageJsonPath: string;
}

export interface SourceUnusedWorkspaceDependencyIssue {
  code: typeof SOURCE_ISSUE_CODES.unusedWorkspaceDependency;
  dependencyName: string;
  ownerName: string;
  packageJsonPath: string;
  sectionName: string;
  specifier: string;
}

export interface SourceStructuredIssue {
  code: SourceIssueCode;
  detailLines?: string[];
  detector?: string;
  evidence?: LiminaCheckIssueEvidence[];
  filePath?: string;
  fix?: string;
  fixSteps?: string[];
  locations?: LiminaCheckIssueLocation[];
  ownerName: string;
  packageJsonPath?: string;
  reason: string;
  scope?: string;
  summary?: string;
  title: string;
  tool?: string;
  verifyCommands?: string[];
}

export type SourceCheckIssue =
  | SourceUnusedModuleIssue
  | SourceUnusedWorkspaceDependencyIssue
  | SourceStructuredIssue;

const DEFAULT_DETAIL_LIMIT = 5;
const DEFAULT_COMMAND = 'limina check';
const ISSUE_BLOCK_MIN_WIDTH = 88;
const ISSUE_BLOCK_HORIZONTAL_PADDING = 2;
const ISSUE_BLOCK_BORDER_WIDTH = 2;
const ANSI_RESET = '\u001B[0m';
const ANSI_BLUE = '\u001B[34m';
const ANSI_CYAN = '\u001B[36m';
const ANSI_GREEN = '\u001B[32m';
const ANSI_MAGENTA = '\u001B[35m';
const ANSI_RED = '\u001B[31m';
const ANSI_YELLOW = '\u001B[33m';
const LABEL_PREFIX_PATTERN = /^(\s*(?:-\s+|\d+\.\s+)?)([A-Za-z][A-Za-z ]*):/u;

type AnsiColor = string;

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

function colorText(color: AnsiColor, text: string): string {
  return `${color}${text}${ANSI_RESET}`;
}

function getLabelColor(label: string): AnsiColor {
  switch (label.toLowerCase()) {
    case 'fix':
    case 'fix steps':
    case 'suggested fix':
    case 'suggested fixes': {
      return ANSI_GREEN;
    }
    case 'reason': {
      return ANSI_YELLOW;
    }
    case 'details':
    case 'evidence': {
      return ANSI_MAGENTA;
    }
    case 'rule': {
      return ANSI_BLUE;
    }
    default: {
      return ANSI_CYAN;
    }
  }
}

function colorIssueTitleLine(line: string): string {
  return colorText(ANSI_RED, line);
}

function colorIssueLabelLine(line: string): string {
  const match = LABEL_PREFIX_PATTERN.exec(line);

  if (!match) {
    return line;
  }

  const prefix = match[1] ?? '';
  const label = match[2] ?? '';
  return `${prefix}${colorText(getLabelColor(label), line.slice(prefix.length))}`;
}

function colorIssueBlockLines(lines: readonly string[]): string[] {
  return lines.map((line, index) =>
    index === 0 ? colorIssueTitleLine(line) : colorIssueLabelLine(line),
  );
}

function hasFilters(options: SourceIssueReportOptions): boolean {
  return Boolean(
    options.packageNames?.length ||
      options.rules?.length ||
      options.files?.length ||
      options.scopes?.length,
  );
}

function formatListFilter(
  label: string,
  values: readonly string[] | undefined,
): string[] {
  return values && values.length > 0
    ? [`  ${label}: ${values.join(', ')}`]
    : [];
}

function formatFilters(options: SourceIssueReportOptions): string[] {
  const lines = [
    ...formatListFilter('package', options.packageNames),
    ...formatListFilter('rule', options.rules),
    ...formatListFilter('file', options.files),
    ...formatListFilter('scope', options.scopes),
  ];

  return lines.length > 0 ? ['Filters:', ...lines] : [];
}

function getSourceIssuePathCandidates(
  issue: SourceUnusedModuleIssue | SourceStructuredIssue,
): PathFilterCandidate[] {
  if (!issue.filePath) {
    return [];
  }

  return [
    {
      kind: 'file',
      path: issue.filePath,
      ...('ownerDirectory' in issue
        ? { scopeRelativeTo: [issue.ownerDirectory] }
        : {}),
    },
  ];
}

function isSourceUnusedModuleIssue(
  issue: SourceCheckIssue,
): issue is SourceUnusedModuleIssue {
  return issue.code === SOURCE_ISSUE_CODES.unusedModule;
}

function isSourceStructuredIssue(
  issue: SourceCheckIssue,
): issue is SourceStructuredIssue {
  return (
    issue.code !== SOURCE_ISSUE_CODES.unusedModule &&
    issue.code !== SOURCE_ISSUE_CODES.unusedWorkspaceDependency
  );
}

function isFileBackedIssue(
  issue: SourceCheckIssue,
): issue is SourceUnusedModuleIssue | SourceStructuredIssue {
  return (
    isSourceUnusedModuleIssue(issue) ||
    (isSourceStructuredIssue(issue) && Boolean(issue.filePath))
  );
}

function issueMatchesFilters(
  config: ResolvedLiminaConfig,
  issue: SourceCheckIssue,
  options: SourceIssueReportOptions,
): boolean {
  if (
    options.packageNames?.length &&
    !options.packageNames.includes(issue.ownerName)
  ) {
    return false;
  }

  if (options.rules?.length && !options.rules.includes(issue.code)) {
    return false;
  }

  if (options.files?.length) {
    if (!isFileBackedIssue(issue)) {
      return false;
    }

    if (!issue.filePath) {
      return false;
    }

    if (
      !pathCandidatesMatchFileFilters({
        candidates: getSourceIssuePathCandidates(issue),
        files: options.files,
        rootDir: config.rootDir,
      })
    ) {
      return false;
    }
  }

  if (
    options.scopes?.length &&
    (!isFileBackedIssue(issue) ||
      !issue.filePath ||
      !pathCandidatesMatchScopeFilters({
        candidates: getSourceIssuePathCandidates(issue),
        rootDir: config.rootDir,
        scopes: options.scopes,
      }))
  ) {
    return false;
  }

  return true;
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );

  for (const [leftIndex, leftChar] of [...left].entries()) {
    const current = [leftIndex + 1];

    for (const [rightIndex, rightChar] of [...right].entries()) {
      current[rightIndex + 1] =
        leftChar === rightChar
          ? previous[rightIndex]
          : Math.min(
              previous[rightIndex] + 1,
              current[rightIndex] + 1,
              previous[rightIndex + 1] + 1,
            );
    }

    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length] ?? 0;
}

function findClosestRule(
  rule: string,
  availableRules: readonly string[],
): string | undefined {
  return availableRules
    .map((availableRule) => ({
      distance: levenshteinDistance(rule, availableRule),
      rule: availableRule,
    }))
    .sort(
      (left, right) =>
        left.distance - right.distance || left.rule.localeCompare(right.rule),
    )[0]?.rule;
}

function formatUnknownRules(
  selectedRules: readonly string[] | undefined,
  availableRules: readonly string[],
): string[] {
  if (!selectedRules?.length) {
    return [];
  }

  const unknownRules = selectedRules.filter(
    (rule) => !availableRules.includes(rule),
  );

  return unknownRules.flatMap((rule) => {
    const suggestion = findClosestRule(rule, availableRules);

    return [
      `Unknown issue rule: ${rule}`,
      ...(suggestion
        ? ['', 'Did you mean:', `  - ${suggestion}`]
        : availableRules.length > 0
          ? [
              '',
              'Available rules with issues:',
              ...availableRules.map((item) => `  - ${item}`),
            ]
          : []),
    ];
  });
}

function formatCommandFlags(options: SourceIssueReportOptions): string {
  const flags = [
    ...(options.packageNames ?? []).flatMap((packageName) => [
      '--package',
      packageName,
    ]),
    ...(options.rules ?? []).flatMap((rule) => ['--rule', rule]),
    ...(options.files ?? []).flatMap((file) => ['--file', file]),
    ...(options.scopes ?? []).flatMap((scope) => ['--scope', scope]),
  ];

  return formatShellCommand(flags);
}

function createVerboseCommand(options: SourceIssueReportOptions): string {
  const command = options.command ?? DEFAULT_COMMAND;
  const filterFlags = formatCommandFlags(options);

  return [command, '--verbose', filterFlags].filter(Boolean).join(' ');
}

function groupUnusedModuleIssues(
  issues: readonly SourceCheckIssue[],
): SourceUnusedModuleIssue[][] {
  const groups = new Map<string, SourceUnusedModuleIssue[]>();

  for (const issue of issues) {
    if (!isSourceUnusedModuleIssue(issue)) {
      continue;
    }

    const key = [issue.code, issue.ownerName, issue.packageJsonPath].join('\0');
    const group = groups.get(key) ?? [];

    group.push(issue);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) =>
      group.sort((left, right) => left.filePath.localeCompare(right.filePath)),
    )
    .sort(
      (left, right) =>
        (left[0]?.ownerName ?? '').localeCompare(right[0]?.ownerName ?? '') ||
        (left[0]?.packageJsonPath ?? '').localeCompare(
          right[0]?.packageJsonPath ?? '',
        ),
    );
}

function isSourceUnusedWorkspaceDependencyIssue(
  issue: SourceCheckIssue,
): issue is SourceUnusedWorkspaceDependencyIssue {
  return issue.code === SOURCE_ISSUE_CODES.unusedWorkspaceDependency;
}

function groupUnusedWorkspaceDependencyIssues(
  issues: readonly SourceCheckIssue[],
): SourceUnusedWorkspaceDependencyIssue[][] {
  const groups = new Map<string, SourceUnusedWorkspaceDependencyIssue[]>();

  for (const issue of issues) {
    if (!isSourceUnusedWorkspaceDependencyIssue(issue)) {
      continue;
    }

    const key = [issue.code, issue.ownerName, issue.packageJsonPath].join('\0');
    const group = groups.get(key) ?? [];

    group.push(issue);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) =>
      group.sort((left, right) =>
        left.dependencyName.localeCompare(right.dependencyName),
      ),
    )
    .sort(
      (left, right) =>
        (left[0]?.ownerName ?? '').localeCompare(right[0]?.ownerName ?? '') ||
        (left[0]?.packageJsonPath ?? '').localeCompare(
          right[0]?.packageJsonPath ?? '',
        ),
    );
}

interface GenericSourceIssueGroup {
  issues: SourceStructuredIssue[];
  key: string;
}

function groupGenericSourceIssues(
  issues: readonly SourceCheckIssue[],
): GenericSourceIssueGroup[] {
  const groups = new Map<string, SourceStructuredIssue[]>();

  for (const issue of issues) {
    if (!isSourceStructuredIssue(issue)) {
      continue;
    }

    const key = [
      issue.code,
      issue.title,
      issue.ownerName,
      issue.packageJsonPath ?? '',
      issue.reason,
      issue.fix ?? '',
      JSON.stringify(issue.fixSteps ?? null),
    ].join('\0');
    const group = groups.get(key) ?? [];

    group.push(issue);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([key, groupedIssues]) => ({
      issues: groupedIssues.sort((left, right) =>
        getGenericSourceIssueLocation(left).localeCompare(
          getGenericSourceIssueLocation(right),
        ),
      ),
      key,
    }))
    .sort(
      (left, right) =>
        (left.issues[0]?.code ?? '').localeCompare(
          right.issues[0]?.code ?? '',
        ) ||
        (left.issues[0]?.ownerName ?? '').localeCompare(
          right.issues[0]?.ownerName ?? '',
        ) ||
        left.key.localeCompare(right.key),
    );
}

function getGenericSourceIssueLocation(issue: SourceStructuredIssue): string {
  const structuredLocation = issue.locations?.find(
    (location) =>
      location.filePath || location.packageManifestPath || location.scope,
  );

  if (structuredLocation) {
    const value =
      structuredLocation.filePath ??
      structuredLocation.packageManifestPath ??
      structuredLocation.scope;

    return [structuredLocation.label, value].filter(Boolean).join(': ');
  }

  return (
    issue.filePath ??
    issue.packageJsonPath ??
    issue.locations?.find((location) => location.filePath)?.filePath ??
    issue.locations?.find((location) => location.packageManifestPath)
      ?.packageManifestPath ??
    issue.scope ??
    issue.title
  );
}

function formatSourceEvidence(
  evidence: readonly LiminaCheckIssueEvidence[] | undefined,
): string[] {
  if (!evidence?.length) {
    return [];
  }

  return [
    'evidence:',
    ...evidence.flatMap((item) => [
      ...(item.label || item.value
        ? [`  - ${[item.label, item.value].filter(Boolean).join(': ')}`]
        : []),
      ...(item.lines ?? []).map((line) => `    ${line}`),
    ]),
  ];
}

function formatGenericSourceIssueGroup(
  group: GenericSourceIssueGroup,
  options: SourceIssueReportOptions,
): string[] {
  const firstIssue = group.issues[0];

  if (!firstIssue) {
    return [];
  }

  const locations = uniqueSortedStrings(
    group.issues.map(getGenericSourceIssueLocation),
  );
  const visibleLocations = options.verbose
    ? locations
    : locations.slice(0, DEFAULT_DETAIL_LIMIT);
  const remainingCount = locations.length - visibleLocations.length;
  const fixSteps = firstIssue.fixSteps?.length
    ? firstIssue.fixSteps
    : firstIssue.fix
      ? [firstIssue.fix]
      : [];

  return [
    `${firstIssue.title}  ${group.issues.length} ${plural(
      group.issues.length,
      'issue',
      'issues',
    )}`,
    `package: ${firstIssue.ownerName}`,
    `rule: ${firstIssue.code}`,
    ...(firstIssue.packageJsonPath
      ? [`package manifest: ${firstIssue.packageJsonPath}`]
      : []),
    ...(firstIssue.detector ? [`detector: ${firstIssue.detector}`] : []),
    ...(firstIssue.tool ? [`tool: ${firstIssue.tool}`] : []),
    '',
    ...(firstIssue.summary ? ['summary:', `  ${firstIssue.summary}`, ''] : []),
    'reason:',
    `  ${firstIssue.reason}`,
    ...(fixSteps.length > 0
      ? [
          '',
          'fix steps:',
          ...fixSteps.map((step, index) => `  ${index + 1}. ${step}`),
        ]
      : []),
    ...(firstIssue.verifyCommands?.length
      ? [
          '',
          'verify:',
          ...firstIssue.verifyCommands.map((command) => `  - ${command}`),
        ]
      : []),
    ...(formatSourceEvidence(firstIssue.evidence).length > 0
      ? ['', ...formatSourceEvidence(firstIssue.evidence)]
      : []),
    '',
    options.verbose ? 'details:' : 'files:',
    ...visibleLocations.map((location) => `  - ${location}`),
    ...(options.verbose
      ? group.issues.flatMap((issue) =>
          issue.detailLines?.length
            ? ['', ...issue.detailLines.map((line) => `    ${line}`)]
            : [],
        )
      : []),
    ...(remainingCount > 0 ? [`  ... ${remainingCount} more`] : []),
    ...(remainingCount > 0
      ? ['', 'Show all files:', `  ${createVerboseCommand(options)}`]
      : []),
  ];
}

function formatUnusedModuleFixes(ownerName: string): string[] {
  return [
    'suggested fixes:',
    '  1. Delete files that are truly unused.',
    '  2. Make files reachable from package manifest entries, binaries, scripts, or Knip plugin entries.',
    '  3. Add intentional files to:',
    `     source.knip.workspaces["${ownerName}"].ignoreFiles`,
    '     with a reason.',
  ];
}

function formatUnusedDependencyFixes(ownerName: string): string[] {
  return [
    'suggested fixes:',
    '  1. Remove dependencies that are truly unused from the package manifest.',
    '  2. Make dependencies reachable from package entries, binaries, scripts, or Knip plugin entries.',
    '  3. Add intentional dependencies to:',
    `     source.knip.workspaces["${ownerName}"].ignoreDependencies`,
    '     with dep and reason.',
  ];
}

function formatUnusedModuleGroupHeader(
  config: ResolvedLiminaConfig,
  group: readonly SourceUnusedModuleIssue[],
): string[] {
  const firstIssue = group[0];

  if (!firstIssue) {
    return [];
  }

  return [
    firstIssue.ownerName,
    `package manifest: ${toRelativePath(config.rootDir, firstIssue.packageJsonPath)}`,
    `rule: ${SOURCE_ISSUE_CODES.unusedModule}`,
    '',
    'reason:',
    '  Owner-governed source modules must be reachable from package entries, binaries, scripts, or Knip plugin entries.',
    '',
    ...formatUnusedModuleFixes(firstIssue.ownerName),
  ];
}

function formatDefaultUnusedModuleGroup(
  config: ResolvedLiminaConfig,
  group: readonly SourceUnusedModuleIssue[],
  options: SourceIssueReportOptions,
): string[] {
  const visibleFiles = group.slice(0, DEFAULT_DETAIL_LIMIT);
  const remainingCount = group.length - visibleFiles.length;

  return [
    ...formatUnusedModuleGroupHeader(config, group),
    '',
    'files:',
    ...visibleFiles.map(
      (issue) => `  - ${toRelativePath(config.rootDir, issue.filePath)}`,
    ),
    ...(remainingCount > 0 ? [`  ... ${remainingCount} more`] : []),
    ...(remainingCount > 0
      ? ['', 'Show all files:', `  ${createVerboseCommand(options)}`]
      : []),
  ];
}

function formatUnusedDependencyGroupHeader(
  config: ResolvedLiminaConfig,
  group: readonly SourceUnusedWorkspaceDependencyIssue[],
): string[] {
  const firstIssue = group[0];

  if (!firstIssue) {
    return [];
  }

  return [
    firstIssue.ownerName,
    `package manifest: ${toRelativePath(config.rootDir, firstIssue.packageJsonPath)}`,
    `rule: ${SOURCE_ISSUE_CODES.unusedWorkspaceDependency}`,
    '',
    'reason:',
    '  Workspace package dependencies must be reachable from package entries, binaries, scripts, or explicitly ignored when usage is not visible to Knip analysis.',
    '',
    ...formatUnusedDependencyFixes(firstIssue.ownerName),
  ];
}

function formatUnusedDependencyItem(
  issue: SourceUnusedWorkspaceDependencyIssue,
): string[] {
  return [
    `  - ${issue.dependencyName}`,
    `    section: ${issue.sectionName}`,
    `    specifier: ${issue.specifier}`,
  ];
}

function formatUnusedDependencyGroup(
  config: ResolvedLiminaConfig,
  group: readonly SourceUnusedWorkspaceDependencyIssue[],
  options: SourceIssueReportOptions,
): string[] {
  const visibleIssues = options.verbose
    ? group
    : group.slice(0, DEFAULT_DETAIL_LIMIT);
  const remainingCount = group.length - visibleIssues.length;

  return [
    ...formatUnusedDependencyGroupHeader(config, group),
    '',
    'dependencies:',
    ...visibleIssues.flatMap(formatUnusedDependencyItem),
    ...(remainingCount > 0 ? [`  ... ${remainingCount} more`] : []),
    ...(remainingCount > 0
      ? ['', 'Show all dependencies:', `  ${createVerboseCommand(options)}`]
      : []),
  ];
}

function getIssueOwnerScope(issue: SourceUnusedModuleIssue): string {
  const ownerRelativeFile = normalizeSlashes(
    toRelativePath(issue.ownerDirectory, issue.filePath),
  );
  const directory = path.posix.dirname(ownerRelativeFile);

  return directory === '.' ? '<package root>' : directory;
}

function groupIssuesByOwnerScope(
  issues: readonly SourceUnusedModuleIssue[],
): Map<string, SourceUnusedModuleIssue[]> {
  const groups = new Map<string, SourceUnusedModuleIssue[]>();

  for (const issue of issues) {
    const scope = getIssueOwnerScope(issue);
    const group = groups.get(scope) ?? [];

    group.push(issue);
    groups.set(scope, group);
  }

  for (const group of groups.values()) {
    group.sort((left, right) => left.filePath.localeCompare(right.filePath));
  }

  return new Map(
    [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function formatVerboseUnusedModuleGroup(
  config: ResolvedLiminaConfig,
  group: readonly SourceUnusedModuleIssue[],
): string[] {
  const scopeGroups = [...groupIssuesByOwnerScope(group).entries()];

  return [
    ...formatUnusedModuleGroupHeader(config, group),
    '',
    'files by scope:',
    '',
    ...scopeGroups.flatMap(([scope, issues], index) => [
      `  ${scope}  ${issues.length} ${plural(issues.length, 'file', 'files')}`,
      ...issues.map(
        (issue) => `    - ${toRelativePath(config.rootDir, issue.filePath)}`,
      ),
      ...(index === scopeGroups.length - 1 ? [] : ['']),
    ]),
  ];
}

function formatNoMatchedIssues(
  issues: readonly SourceCheckIssue[],
  options: SourceIssueReportOptions,
): string[] {
  const packages = uniqueSortedStrings(issues.map((issue) => issue.ownerName));
  const rules = uniqueSortedStrings(issues.map((issue) => issue.code));

  return [
    'No issues matched the selected filters.',
    '',
    ...formatFilters(options),
    ...(packages.length > 0
      ? [
          '',
          'Available packages with issues:',
          ...packages.map((item) => `  - ${item}`),
        ]
      : []),
    ...(rules.length > 0
      ? [
          '',
          'Available rules with issues:',
          ...rules.map((item) => `  - ${item}`),
        ]
      : []),
  ];
}

function getLineWrapPrefix(line: string): {
  content: string;
  firstPrefix: string;
  nextPrefix: string;
} {
  const firstPrefix = /^\s*(?:-\s+|\d+\.\s+)?/u.exec(line)?.[0] ?? '';

  return {
    content: line.slice(firstPrefix.length),
    firstPrefix,
    nextPrefix: ' '.repeat(firstPrefix.length),
  };
}

function getIssueBlockContentWidth(blockWidth: number): number {
  return Math.max(
    1,
    blockWidth - ISSUE_BLOCK_BORDER_WIDTH - ISSUE_BLOCK_HORIZONTAL_PADDING,
  );
}

function isFilesHeading(line: string): boolean {
  return line === 'files:' || line === 'files by scope:';
}

function getRequiredFilesLineWidth(lines: readonly string[]): number {
  let inFilesSection = false;
  let requiredWidth = 0;

  for (const line of lines) {
    if (isFilesHeading(line)) {
      inFilesSection = true;
      continue;
    }

    if (!inFilesSection) {
      continue;
    }

    if (/^\s+-\s+\S/u.test(line)) {
      requiredWidth = Math.max(requiredWidth, line.length);
    }
  }

  return requiredWidth;
}

function getIssueBlockWidth(lines: readonly string[]): number {
  const requiredFilesWidth =
    getRequiredFilesLineWidth(lines) +
    ISSUE_BLOCK_BORDER_WIDTH +
    ISSUE_BLOCK_HORIZONTAL_PADDING;

  return Math.max(ISSUE_BLOCK_MIN_WIDTH, requiredFilesWidth);
}

function wrapIssueLine(line: string, contentWidth: number): string[] {
  if (!line) {
    return [line];
  }

  const { content, firstPrefix, nextPrefix } = getLineWrapPrefix(line);
  const continuationWidth = Math.max(1, contentWidth - firstPrefix.length);

  if (content.length <= continuationWidth) {
    return [line];
  }

  const wrapped: string[] = [];
  let current = '';

  const splitLongWord = (word: string): string[] => {
    const chunks: string[] = [];

    if (word.includes('/')) {
      let chunk = '';
      const pathParts = word
        .split('/')
        .map((part, index, parts) =>
          index === parts.length - 1 ? part : `${part}/`,
        );

      for (const part of pathParts) {
        if (part.length > continuationWidth) {
          if (chunk) {
            chunks.push(chunk);
            chunk = '';
          }

          for (let index = 0; index < part.length; index += continuationWidth) {
            chunks.push(part.slice(index, index + continuationWidth));
          }

          continue;
        }

        if (chunk && chunk.length + part.length > continuationWidth) {
          chunks.push(chunk);
          chunk = '';
        }

        chunk = `${chunk}${part}`;
      }

      if (chunk) {
        chunks.push(chunk);
      }

      return chunks;
    }

    for (let index = 0; index < word.length; index += continuationWidth) {
      chunks.push(word.slice(index, index + continuationWidth));
    }

    return chunks;
  };

  const pushLongWord = (word: string): void => {
    wrapped.push(...splitLongWord(word));
  };

  for (const word of content.split(/\s+/u)) {
    if (!word) {
      continue;
    }

    if (!current) {
      if (word.length > continuationWidth) {
        pushLongWord(word);
        continue;
      }

      current = word;
      continue;
    }

    if (current.length + 1 + word.length <= continuationWidth) {
      current = `${current} ${word}`;
      continue;
    }

    wrapped.push(current);
    current = '';

    if (word.length > continuationWidth) {
      pushLongWord(word);
      continue;
    }

    current = word;
  }

  if (current) {
    wrapped.push(current);
  }

  return wrapped.map((part, index) =>
    index === 0 ? `${firstPrefix}${part}` : `${nextPrefix}${part}`,
  );
}

function formatIssueBlock(
  lines: readonly string[],
  options: { title?: string } = {},
): string[] {
  const width = getIssueBlockWidth(lines);
  const contentWidth = getIssueBlockContentWidth(width);
  const wrappedLines = lines.flatMap((line) =>
    wrapIssueLine(line, contentWidth),
  );
  const coloredLines = colorIssueBlockLines(wrappedLines);

  return boxen(coloredLines.join('\n'), {
    borderStyle: 'single',
    padding: {
      left: 1,
      right: 1,
    },
    title: options.title,
    width,
  }).split('\n');
}

function formatSummaryBlock(summaryLines: readonly string[]): string[] {
  return formatCheckSummaryBlock({
    lines: summaryLines,
    title: 'Source check summary',
  });
}

export function formatSourceCheckHumanReport(options: {
  config: ResolvedLiminaConfig;
  issues: readonly SourceCheckIssue[];
  report?: SourceIssueReportOptions;
}): string {
  const report = options.report ?? {};
  const availableRules = uniqueSortedStrings(
    options.issues.map((issue) => issue.code),
  );
  const unknownRuleLines = formatUnknownRules(report.rules, availableRules);
  const filteredIssues = options.issues.filter((issue) =>
    issueMatchesFilters(options.config, issue, report),
  );
  const activeFilters = hasFilters(report);
  const lines = [...unknownRuleLines];

  if (unknownRuleLines.length > 0) {
    lines.push('');
  }

  if (activeFilters && filteredIssues.length === 0) {
    lines.push(...formatNoMatchedIssues(options.issues, report));

    return lines.join('\n');
  }

  const unusedModuleGroups = groupUnusedModuleIssues(filteredIssues);
  const unusedDependencyGroups =
    groupUnusedWorkspaceDependencyIssues(filteredIssues);
  const genericIssueGroups = groupGenericSourceIssues(filteredIssues);
  const unusedModuleIssueCount = unusedModuleGroups.reduce(
    (count, group) => count + group.length,
    0,
  );
  const unusedDependencyIssueCount = unusedDependencyGroups.reduce(
    (count, group) => count + group.length,
    0,
  );
  const genericIssueCount = genericIssueGroups.reduce(
    (count, group) => count + group.issues.length,
    0,
  );

  if (activeFilters) {
    lines.push(...formatFilters(report), '');
  }

  if (report.verbose && activeFilters) {
    lines.push(
      `Matched ${filteredIssues.length} ${plural(filteredIssues.length, 'issue', 'issues')}.`,
      '',
    );
  } else {
    const summaryLines: string[] = [];

    if (unusedModuleIssueCount > 0) {
      const packageCount = uniqueSortedStrings(
        unusedModuleGroups.flatMap((group) =>
          group[0] ? [group[0].ownerName] : [],
        ),
      ).length;

      summaryLines.push(
        `Found ${unusedModuleIssueCount} unused source ${plural(unusedModuleIssueCount, 'module', 'modules')} in ${packageCount} ${plural(packageCount, 'package', 'packages')}.`,
      );
    }

    if (unusedDependencyIssueCount > 0) {
      const packageCount = uniqueSortedStrings(
        unusedDependencyGroups.flatMap((group) =>
          group[0] ? [group[0].ownerName] : [],
        ),
      ).length;

      summaryLines.push(
        `Found ${unusedDependencyIssueCount} unused workspace package ${plural(unusedDependencyIssueCount, 'dependency', 'dependencies')} in ${packageCount} ${plural(packageCount, 'package', 'packages')}.`,
      );
    }

    if (genericIssueCount > 0) {
      const packageCount = uniqueSortedStrings(
        genericIssueGroups.flatMap((group) =>
          group.issues[0] ? [group.issues[0].ownerName] : [],
        ),
      ).length;

      summaryLines.push(
        `Found ${genericIssueCount} source check ${plural(genericIssueCount, 'issue', 'issues')} in ${packageCount} ${plural(packageCount, 'package', 'packages')}.`,
      );
    }

    if (summaryLines.length > 0) {
      lines.push(...formatSummaryBlock(summaryLines), '');
    }
  }

  for (const [index, group] of unusedModuleGroups.entries()) {
    if (index > 0) {
      lines.push('');
    }

    lines.push(
      ...formatIssueBlock(
        report.verbose
          ? formatVerboseUnusedModuleGroup(options.config, group)
          : formatDefaultUnusedModuleGroup(options.config, group, report),
      ),
    );
  }

  for (const group of unusedDependencyGroups) {
    if (lines.length > 0) {
      lines.push('');
    }

    lines.push(
      ...formatIssueBlock(
        formatUnusedDependencyGroup(options.config, group, report),
      ),
    );
  }

  for (const group of genericIssueGroups) {
    if (lines.length > 0) {
      lines.push('');
    }

    lines.push(
      ...formatIssueBlock(formatGenericSourceIssueGroup(group, report)),
    );
  }

  return lines.join('\n').trim();
}
