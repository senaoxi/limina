import type { ShellCommandDialect } from './shell-command';
import { formatShellCommand } from './shell-command';
import type {
  CheckIssueInventoryFilters,
  LiminaCheckIssue,
  LiminaCheckIssueLocation,
  LiminaCheckIssueSeverity,
} from './snapshot';

export const DEFAULT_VISIBLE_ISSUE_LIMIT = 20;
export const DEFAULT_PRIMARY_BLOCKER_LIMIT = 3;

export type CheckIssueInventoryView = 'compact' | 'detailed' | 'summary';

export interface CheckIssueInventoryPresentationOptions {
  maxIssues: number | null;
  maxPrimaryBlockers: number;
  view: CheckIssueInventoryView;
}

export interface InventoryGlobalCommandContext {
  configLoader?: string;
  configPath?: string;
  mode?: string;
}

export interface InventoryQueryContext {
  effectiveFormat: 'human';
  filters: CheckIssueInventoryFilters;
  global: InventoryGlobalCommandContext;
  invocationId?: string;
  limit: number | null;
  limitExplicit: boolean;
  verbose: boolean;
}

export interface HumanCountEntry {
  count: number;
  name: string;
}

export interface HumanPrimaryBlocker {
  affectedFiles: number;
  affectedPackages: number;
  checkerName?: string;
  code: string;
  count: number;
  detector?: string;
  domain?: string;
  packages: HumanCountEntry[];
  representative: LiminaCheckIssue;
  representativeLocation?: string;
  severity?: LiminaCheckIssueSeverity;
  summary: string;
  task: string;
  title: string;
  tool?: string;
}

export type InventoryFilterHelpKind = 'checker' | 'package' | 'rule' | 'task';

export type InventoryCommandLimit = 'all' | 'omit' | 'preserve' | number;

export interface FormatInventoryQueryCommandOptions {
  additionalFilters?: CheckIssueInventoryFilters;
  dialect?: ShellCommandDialect;
  filterHelp?: InventoryFilterHelpKind;
  format?: 'human' | 'json';
  limit?: InventoryCommandLimit;
  verbose?: boolean;
}

type CanonicalLocationTuple = readonly [
  label: string,
  filePath: string,
  packageManifestPath: string,
  scope: string,
  line: number | null,
  column: number | null,
];

interface CanonicalLocationCandidate {
  display: string;
  key: string;
}

type RootCauseTuple = readonly [
  task: string,
  code: string,
  title: string,
  checkerName: string,
  tool: string,
  domain: string,
  detector: string,
];

interface RootCauseBucket {
  key: string;
  packageBuckets: PackageBucket[];
  representative: LiminaCheckIssue;
  severity: LiminaCheckIssueSeverity | undefined;
}

const NO_PACKAGE = Symbol('no-package');
type PackageBucketKey = string | typeof NO_PACKAGE;

interface PackageBucket {
  issues: LiminaCheckIssue[];
  key: PackageBucketKey;
  representative: LiminaCheckIssue;
}

interface PackageBucketCursor {
  bucket: PackageBucket;
  issueIndex: number;
}

interface RootCauseBucketCursor {
  bucket: RootCauseBucket;
  nextPackageIndex: number;
  packages: PackageBucketCursor[];
}

interface MutableHumanPrimaryBlocker {
  files: Set<string>;
  issues: LiminaCheckIssue[];
  key: string;
  packageCounts: Map<string, number>;
}

export function compareCodeUnits(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

export function getIssueSeverityRank(
  severity: LiminaCheckIssueSeverity | undefined,
): number {
  if (severity === 'error' || severity === undefined) {
    return 3;
  }

  return severity === 'warning' ? 2 : 1;
}

function createLocationTuple(
  location: LiminaCheckIssueLocation,
): CanonicalLocationTuple {
  return [
    location.label ?? '',
    location.filePath ?? '',
    location.packageManifestPath ?? '',
    location.scope ?? '',
    location.line ?? null,
    location.column ?? null,
  ];
}

function formatLocationTuple(tuple: CanonicalLocationTuple): string {
  const [label, filePath, packageManifestPath, scope, line, column] = tuple;
  const pathValue = filePath || packageManifestPath;
  const position =
    pathValue && line !== null
      ? `:${line}${column === null ? '' : `:${column}`}`
      : '';
  const value = `${pathValue || scope}${position}`;

  return [label, value].filter(Boolean).join(': ');
}

function createCanonicalLocationCandidate(
  location: LiminaCheckIssueLocation,
): CanonicalLocationCandidate | null {
  const tuple = createLocationTuple(location);
  const display = formatLocationTuple(tuple);
  const [label, filePath, packageManifestPath, scope, line, column] = tuple;
  const kind = filePath ? 0 : packageManifestPath ? 1 : scope ? 2 : 3;

  return display
    ? {
        display,
        key: JSON.stringify([
          kind,
          filePath || packageManifestPath || scope,
          label,
          line,
          column,
        ]),
      }
    : null;
}

function getCanonicalLocationCandidates(
  issue: LiminaCheckIssue,
): CanonicalLocationCandidate[] {
  const locations: LiminaCheckIssueLocation[] = [
    ...(issue.filePath ? [{ filePath: issue.filePath }] : []),
    ...(issue.packageManifestPath
      ? [{ packageManifestPath: issue.packageManifestPath }]
      : []),
    ...(issue.scope ? [{ scope: issue.scope }] : []),
    ...(issue.locations ?? []),
  ];
  const seenKeys = new Set<string>();

  return locations
    .map(createCanonicalLocationCandidate)
    .filter(
      (candidate): candidate is CanonicalLocationCandidate =>
        candidate !== null &&
        !seenKeys.has(candidate.key) &&
        Boolean(seenKeys.add(candidate.key)),
    )
    .sort((left, right) => compareCodeUnits(left.key, right.key));
}

export function getCanonicalIssueLocationKey(issue: LiminaCheckIssue): string {
  return getCanonicalLocationCandidates(issue)[0]?.key ?? '';
}

export function getCanonicalIssueLocation(
  issue: LiminaCheckIssue,
): string | undefined {
  return getCanonicalLocationCandidates(issue)[0]?.display;
}

export function getAllCanonicalIssueLocations(
  issue: LiminaCheckIssue,
): string[] {
  return getCanonicalLocationCandidates(issue).map(
    (candidate) => candidate.display,
  );
}

export function getAllIssueFilePaths(issue: LiminaCheckIssue): string[] {
  return [
    issue.filePath,
    issue.packageManifestPath,
    ...(issue.locations ?? []).flatMap((location) => [
      location.filePath,
      location.packageManifestPath,
    ]),
  ].filter((value): value is string => Boolean(value));
}

export function createCanonicalIssueFingerprint(
  issue: LiminaCheckIssue,
): string {
  return JSON.stringify([
    issue.id ?? '',
    issue.task,
    issue.code,
    issue.title,
    issue.reason,
    issue.severity ?? '',
    issue.summary ?? '',
    issue.domain ?? '',
    issue.detector ?? '',
    issue.checkerName ?? '',
    issue.tool ?? '',
    issue.packageName ?? '',
    issue.filePath ?? '',
    issue.packageManifestPath ?? '',
    issue.scope ?? '',
    issue.fix ?? '',
    issue.detailLines ?? [],
    issue.fixSteps ?? [],
    issue.verifyCommands ?? [],
    (issue.locations ?? []).map((location) => createLocationTuple(location)),
    (issue.evidence ?? []).map((evidence) => [
      evidence.label ?? '',
      evidence.value ?? '',
      evidence.lines ?? [],
    ]),
    issue.external
      ? [
          issue.external.code ?? '',
          issue.external.message ?? '',
          issue.external.tool ?? '',
          issue.external.url ?? '',
        ]
      : [],
  ]);
}

export function compareCanonicalIssues(
  left: LiminaCheckIssue,
  right: LiminaCheckIssue,
): number {
  return (
    getIssueSeverityRank(right.severity) -
      getIssueSeverityRank(left.severity) ||
    compareCodeUnits(left.task, right.task) ||
    compareCodeUnits(left.code, right.code) ||
    compareCodeUnits(left.title, right.title) ||
    compareCodeUnits(left.packageName ?? '', right.packageName ?? '') ||
    compareCodeUnits(left.checkerName ?? '', right.checkerName ?? '') ||
    compareCodeUnits(left.tool ?? '', right.tool ?? '') ||
    compareCodeUnits(
      getCanonicalIssueLocationKey(left),
      getCanonicalIssueLocationKey(right),
    ) ||
    compareCodeUnits(left.id ?? '', right.id ?? '') ||
    compareCodeUnits(
      createCanonicalIssueFingerprint(left),
      createCanonicalIssueFingerprint(right),
    )
  );
}

function createRootCauseTuple(issue: LiminaCheckIssue): RootCauseTuple {
  return [
    issue.task,
    issue.code,
    issue.title,
    issue.checkerName ?? '',
    issue.tool ?? '',
    issue.domain ?? '',
    issue.detector ?? '',
  ];
}

function createRootCauseKey(issue: LiminaCheckIssue): string {
  return JSON.stringify(createRootCauseTuple(issue));
}

function comparePackageBucketKeys(
  left: PackageBucketKey,
  right: PackageBucketKey,
): number {
  if (left === right) {
    return 0;
  }

  if (left === NO_PACKAGE) {
    return -1;
  }

  if (right === NO_PACKAGE) {
    return 1;
  }

  return compareCodeUnits(left, right);
}

function getHighestSeverity(
  issues: readonly LiminaCheckIssue[],
): LiminaCheckIssueSeverity | undefined {
  let highest: LiminaCheckIssueSeverity | undefined;
  let highestRank = -1;

  for (const issue of issues) {
    const rank = getIssueSeverityRank(issue.severity);

    if (rank > highestRank) {
      highest = issue.severity;
      highestRank = rank;
    }
  }

  return highest;
}

function createRootCauseBuckets(
  issues: readonly LiminaCheckIssue[],
): RootCauseBucket[] {
  const rootGroups = new Map<string, LiminaCheckIssue[]>();

  for (const issue of issues) {
    const key = createRootCauseKey(issue);
    const group = rootGroups.get(key) ?? [];

    group.push(issue);
    rootGroups.set(key, group);
  }

  return [...rootGroups.entries()]
    .map(([key, rootIssues]): RootCauseBucket => {
      const packageGroups = new Map<PackageBucketKey, LiminaCheckIssue[]>();

      for (const issue of rootIssues) {
        const packageKey = issue.packageName ?? NO_PACKAGE;
        const packageIssues = packageGroups.get(packageKey) ?? [];

        packageIssues.push(issue);
        packageGroups.set(packageKey, packageIssues);
      }

      const packageBuckets = [...packageGroups.entries()]
        .map(([packageKey, packageIssues]): PackageBucket => {
          const sortedIssues = [...packageIssues].sort(compareCanonicalIssues);

          return {
            issues: sortedIssues,
            key: packageKey,
            representative: sortedIssues[0]!,
          };
        })
        .sort(
          (left, right) =>
            comparePackageBucketKeys(left.key, right.key) ||
            compareCanonicalIssues(left.representative, right.representative),
        );
      const sortedRootIssues = [...rootIssues].sort(compareCanonicalIssues);

      return {
        key,
        packageBuckets,
        representative: sortedRootIssues[0]!,
        severity: getHighestSeverity(rootIssues),
      };
    })
    .sort(
      (left, right) =>
        getIssueSeverityRank(right.severity) -
          getIssueSeverityRank(left.severity) ||
        compareCanonicalIssues(left.representative, right.representative) ||
        compareCodeUnits(left.key, right.key),
    );
}

function takeNextRootCauseIssue(
  cursor: RootCauseBucketCursor,
): LiminaCheckIssue | undefined {
  const packageCount = cursor.packages.length;

  for (let attempt = 0; attempt < packageCount; attempt += 1) {
    const packageIndex = cursor.nextPackageIndex % packageCount;
    const packageCursor = cursor.packages[packageIndex]!;

    cursor.nextPackageIndex = (packageIndex + 1) % packageCount;

    if (packageCursor.issueIndex >= packageCursor.bucket.issues.length) {
      continue;
    }

    const issue = packageCursor.bucket.issues[packageCursor.issueIndex];
    packageCursor.issueIndex += 1;
    return issue;
  }

  return undefined;
}

export function selectInventoryIssues(
  issues: readonly LiminaCheckIssue[],
  maxIssues: number | null,
): LiminaCheckIssue[] {
  if (maxIssues !== null && maxIssues <= 0) {
    return [];
  }

  const cursors = createRootCauseBuckets(issues).map(
    (bucket): RootCauseBucketCursor => ({
      bucket,
      nextPackageIndex: 0,
      packages: bucket.packageBuckets.map(
        (packageBucket): PackageBucketCursor => ({
          bucket: packageBucket,
          issueIndex: 0,
        }),
      ),
    }),
  );
  const selected: LiminaCheckIssue[] = [];
  const selectionLimit = maxIssues ?? issues.length;

  while (selected.length < selectionLimit) {
    let selectedInRound = false;

    for (const cursor of cursors) {
      if (selected.length >= selectionLimit) {
        break;
      }

      const issue = takeNextRootCauseIssue(cursor);

      if (issue) {
        selected.push(issue);
        selectedInRound = true;
      }
    }

    if (!selectedInRound) {
      break;
    }
  }

  return selected;
}

function incrementMapCount(counts: Map<string, number>, value: string): void {
  counts.set(value, (counts.get(value) ?? 0) + 1);
}

function compareHumanPrimaryBlockers(
  left: HumanPrimaryBlocker,
  right: HumanPrimaryBlocker,
): number {
  return (
    getIssueSeverityRank(right.severity) -
      getIssueSeverityRank(left.severity) ||
    right.count - left.count ||
    right.affectedPackages - left.affectedPackages ||
    right.affectedFiles - left.affectedFiles ||
    compareCanonicalIssues(left.representative, right.representative) ||
    compareCodeUnits(
      createRootCauseKey(left.representative),
      createRootCauseKey(right.representative),
    )
  );
}

export function selectHumanPrimaryBlockers(
  issues: readonly LiminaCheckIssue[],
  limit: number = DEFAULT_PRIMARY_BLOCKER_LIMIT,
): HumanPrimaryBlocker[] {
  const groups = new Map<string, MutableHumanPrimaryBlocker>();

  for (const issue of issues) {
    const key = createRootCauseKey(issue);
    const group = groups.get(key) ?? {
      files: new Set<string>(),
      issues: [],
      key,
      packageCounts: new Map<string, number>(),
    };

    for (const filePath of getAllIssueFilePaths(issue)) {
      group.files.add(filePath);
    }

    if (issue.packageName) {
      incrementMapCount(group.packageCounts, issue.packageName);
    }

    group.issues.push(issue);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group): HumanPrimaryBlocker => {
      const sortedIssues = [...group.issues].sort(compareCanonicalIssues);
      const representative = sortedIssues[0]!;
      const packages = [...group.packageCounts.entries()]
        .map(([name, count]): HumanCountEntry => ({ count, name }))
        .sort(
          (left, right) =>
            right.count - left.count || compareCodeUnits(left.name, right.name),
        );

      return {
        affectedFiles: group.files.size,
        affectedPackages: packages.length,
        checkerName: representative.checkerName,
        code: representative.code,
        count: group.issues.length,
        detector: representative.detector,
        domain: representative.domain,
        packages,
        representative,
        representativeLocation: getCanonicalIssueLocation(representative),
        severity: getHighestSeverity(group.issues),
        summary: representative.summary ?? representative.reason,
        task: representative.task,
        title: representative.title,
        tool: representative.tool,
      };
    })
    .sort(compareHumanPrimaryBlockers)
    .slice(0, Math.max(0, limit));
}

function uniqueInOrder(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();

  return (values ?? []).filter((value) => {
    if (seen.has(value)) {
      return false;
    }

    seen.add(value);
    return true;
  });
}

function mergeFilterValues(
  current: readonly string[] | undefined,
  additional: readonly string[] | undefined,
): string[] {
  return uniqueInOrder([...(current ?? []), ...(additional ?? [])]);
}

function mergeInventoryFilters(
  current: CheckIssueInventoryFilters,
  additional: CheckIssueInventoryFilters | undefined,
): CheckIssueInventoryFilters {
  return {
    checkerNames: mergeFilterValues(
      current.checkerNames,
      additional?.checkerNames,
    ),
    files: mergeFilterValues(current.files, additional?.files),
    packageNames: mergeFilterValues(
      current.packageNames,
      additional?.packageNames,
    ),
    rules: mergeFilterValues(current.rules, additional?.rules),
    scopes: mergeFilterValues(current.scopes, additional?.scopes),
    tasks: mergeFilterValues(current.tasks, additional?.tasks),
  };
}

function appendRepeatedFilterTokens(
  tokens: string[],
  option: string,
  values: readonly string[] | undefined,
): void {
  for (const value of values ?? []) {
    tokens.push(option, value);
  }
}

function appendInventoryFilterTokens(
  tokens: string[],
  filters: CheckIssueInventoryFilters,
): void {
  appendRepeatedFilterTokens(tokens, '--task', filters.tasks);
  appendRepeatedFilterTokens(tokens, '--rule', filters.rules);
  appendRepeatedFilterTokens(tokens, '--package', filters.packageNames);
  appendRepeatedFilterTokens(tokens, '--file', filters.files);
  appendRepeatedFilterTokens(tokens, '--scope', filters.scopes);
  appendRepeatedFilterTokens(tokens, '--checker', filters.checkerNames);
}

function appendHumanViewTokens(
  tokens: string[],
  context: InventoryQueryContext,
  options: FormatInventoryQueryCommandOptions,
): void {
  if (options.filterHelp) {
    tokens.push(`--${options.filterHelp}`, '--help');
    return;
  }

  if (options.verbose) {
    tokens.push('--verbose');
  }

  const limit = options.limit ?? 'omit';

  if (typeof limit === 'number') {
    tokens.push('--limit', String(limit));
  } else if (limit === 'all') {
    tokens.push('--limit', 'all');
  } else if (limit === 'preserve' && context.limitExplicit) {
    tokens.push(
      '--limit',
      context.limit === null ? 'all' : String(context.limit),
    );
  }
}

export function formatInventoryQueryCommand(
  context: InventoryQueryContext,
  options: FormatInventoryQueryCommandOptions = {},
): string {
  const tokens = ['limina'];

  if (context.global.configPath) {
    tokens.push('--config', context.global.configPath);
  }

  if (context.global.configLoader) {
    tokens.push('--config-loader', context.global.configLoader);
  }

  if (context.global.mode) {
    tokens.push('--mode', context.global.mode);
  }

  tokens.push('check', '--issues');

  if (context.invocationId) {
    tokens.push('--invocation', context.invocationId);
  }

  appendInventoryFilterTokens(
    tokens,
    mergeInventoryFilters(context.filters, options.additionalFilters),
  );

  if (options.format === 'json') {
    tokens.push('--format', 'json');
  } else {
    appendHumanViewTokens(tokens, context, options);
  }

  return formatShellCommand(tokens, options.dialect);
}
