import { normalizeSlashes, toRelativePath } from '#utils/path';
import { isPlainRecord } from '#utils/values';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'pathe';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import { formatCheckIssueHumanReport } from '../check-reporting/human';
import { createLiminaCheckIssue } from '../check-reporting/structured';
import {
  createIssueOverview,
  formatCheckIssueSnapshotSummaryHuman,
  selectTopBlockers,
} from '../check-reporting/summary';
import { generatedRootDirName } from '../core/build-graph/generated/paths';
import type {
  SourceCheckIssue,
  SourceIssueCode,
  SourceUnusedModuleIssue,
  SourceUnusedWorkspaceDependencyIssue,
} from './report';

export const SOURCE_ISSUE_SNAPSHOT_VERSION = 1;
export const CHECK_ISSUE_SNAPSHOT_VERSION = 4;

const SUPPORTED_CHECK_ISSUE_SNAPSHOT_VERSIONS = new Set([1, 2, 3, 4]);

export type LiminaCheckTaskName =
  | 'checker:build'
  | 'checker:typecheck'
  | 'command'
  | 'graph:check'
  | 'graph:prepare'
  | 'package:check'
  | 'proof:check'
  | 'release:check'
  | 'source:check';

export type SourceIssueSnapshotStatus = 'completed' | 'not-run';
export type CheckIssueSnapshotStatus = 'completed' | 'not-run';
export type LiminaCheckIssueSeverity = 'error' | 'info' | 'warning';
export type LiminaCheckRunResult =
  | 'blocked'
  | 'failed'
  | 'not-run'
  | 'passed'
  | 'running';
export type LiminaCheckRunTaskKind = 'command' | 'task';
export type LiminaCheckRunTaskStatus =
  | 'failed'
  | 'passed'
  | 'planned'
  | 'running'
  | 'skipped';
export type LiminaCheckRunCheckItemStatus = 'failed' | 'passed';

export interface LiminaCheckRunBlockedBy {
  reason?: string;
  task: string;
}

export interface LiminaCheckRunCheckItemSummary {
  checksPassed?: number;
  checksTotal?: number;
  durationMs?: number;
  issues?: number;
  name: string;
  status: LiminaCheckRunCheckItemStatus;
}

export interface LiminaCheckRunTaskSummary {
  blockedBy?: string;
  checkItems?: LiminaCheckRunCheckItemSummary[];
  checksPassed?: number;
  checksTotal?: number;
  completedAt?: string;
  durationMs?: number;
  kind: LiminaCheckRunTaskKind;
  name: string;
  reason?: string;
  startedAt?: string;
  status: LiminaCheckRunTaskStatus;
}

export interface LiminaCheckRunSummary {
  blockedBy?: LiminaCheckRunBlockedBy;
  command: string;
  completedAt?: string;
  configPath?: string;
  createdAt: string;
  durationMs?: number;
  pipeline?: string;
  result: LiminaCheckRunResult;
  startedAt?: string;
  tasks: LiminaCheckRunTaskSummary[];
}

export interface LiminaCheckIssueLocation {
  column?: number;
  filePath?: string;
  label?: string;
  line?: number;
  packageManifestPath?: string;
  scope?: string;
}

export interface LiminaCheckIssueEvidence {
  label?: string;
  lines?: string[];
  value?: string;
}

export interface LiminaCheckIssueExternal {
  code?: string;
  message?: string;
  tool?: string;
  url?: string;
}

export interface LiminaCheckIssue {
  checkerName?: string;
  code: string;
  detector?: string;
  detailLines?: string[];
  domain?: string;
  evidence?: LiminaCheckIssueEvidence[];
  external?: LiminaCheckIssueExternal;
  filePath?: string;
  fix?: string;
  fixSteps?: string[];
  id?: string;
  locations?: LiminaCheckIssueLocation[];
  packageManifestPath?: string;
  packageName?: string;
  reason: string;
  scope?: string;
  severity?: LiminaCheckIssueSeverity;
  summary?: string;
  task: LiminaCheckTaskName;
  title: string;
  tool?: string;
  verifyCommands?: string[];
}

export interface CheckIssueSnapshot {
  command: string;
  createdAt: string;
  issues: LiminaCheckIssue[];
  run?: LiminaCheckRunSummary;
  status: CheckIssueSnapshotStatus;
  version: 1 | 2 | 3 | typeof CHECK_ISSUE_SNAPSHOT_VERSION;
}

export interface CheckIssueInventoryFilters {
  checkerNames?: readonly string[];
  files?: readonly string[];
  packageNames?: readonly string[];
  rules?: readonly string[];
  scopes?: readonly string[];
  tasks?: readonly string[];
}

export type CheckIssueInventoryFormat = 'human' | 'json' | 'ndjson';

export interface CheckIssueInventoryOptions {
  filters?: CheckIssueInventoryFilters;
  format?: CheckIssueInventoryFormat;
  rootDir?: string;
  snapshot: CheckIssueSnapshot | null;
  verbose?: boolean;
}

export interface SourceIssueSnapshotIssue {
  code: SourceIssueCode;
  filePath?: string;
  ownerName: string;
}

export interface SourceIssueSnapshot {
  command: string;
  createdAt: string;
  issues: SourceIssueSnapshotIssue[];
  legacyProblemCount: number;
  status: SourceIssueSnapshotStatus;
  version: typeof SOURCE_ISSUE_SNAPSHOT_VERSION;
}

function isSourceIssueSnapshotStatus(
  value: unknown,
): value is SourceIssueSnapshotStatus {
  return value === 'completed' || value === 'not-run';
}

function isCheckIssueSnapshotStatus(
  value: unknown,
): value is CheckIssueSnapshotStatus {
  return value === 'completed' || value === 'not-run';
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((line) => typeof line === 'string')
  );
}

function isLiminaCheckIssueSeverity(
  value: unknown,
): value is LiminaCheckIssueSeverity {
  return value === 'error' || value === 'warning' || value === 'info';
}

function isLiminaCheckRunResult(value: unknown): value is LiminaCheckRunResult {
  return (
    value === 'blocked' ||
    value === 'failed' ||
    value === 'not-run' ||
    value === 'passed' ||
    value === 'running'
  );
}

function isLiminaCheckRunTaskKind(
  value: unknown,
): value is LiminaCheckRunTaskKind {
  return value === 'command' || value === 'task';
}

function isLiminaCheckRunCheckItemStatus(
  value: unknown,
): value is LiminaCheckRunCheckItemStatus {
  return value === 'failed' || value === 'passed';
}

function isLiminaCheckRunTaskStatus(
  value: unknown,
): value is LiminaCheckRunTaskStatus {
  return (
    value === 'failed' ||
    value === 'passed' ||
    value === 'planned' ||
    value === 'running' ||
    value === 'skipped'
  );
}

function isLiminaCheckRunBlockedBy(
  value: unknown,
): value is LiminaCheckRunBlockedBy {
  return (
    isPlainRecord(value) &&
    typeof value.task === 'string' &&
    (value.reason === undefined || typeof value.reason === 'string')
  );
}

function isLiminaCheckRunCheckItemSummary(
  value: unknown,
): value is LiminaCheckRunCheckItemSummary {
  return (
    isPlainRecord(value) &&
    typeof value.name === 'string' &&
    isLiminaCheckRunCheckItemStatus(value.status) &&
    (value.checksPassed === undefined ||
      typeof value.checksPassed === 'number') &&
    (value.checksTotal === undefined ||
      typeof value.checksTotal === 'number') &&
    (value.durationMs === undefined || typeof value.durationMs === 'number') &&
    (value.issues === undefined || typeof value.issues === 'number')
  );
}

function isLiminaCheckRunTaskSummary(
  value: unknown,
): value is LiminaCheckRunTaskSummary {
  return (
    isPlainRecord(value) &&
    typeof value.name === 'string' &&
    isLiminaCheckRunTaskKind(value.kind) &&
    isLiminaCheckRunTaskStatus(value.status) &&
    (value.startedAt === undefined || typeof value.startedAt === 'string') &&
    (value.completedAt === undefined ||
      typeof value.completedAt === 'string') &&
    (value.checksPassed === undefined ||
      typeof value.checksPassed === 'number') &&
    (value.checksTotal === undefined ||
      typeof value.checksTotal === 'number') &&
    (value.checkItems === undefined ||
      (Array.isArray(value.checkItems) &&
        value.checkItems.every(isLiminaCheckRunCheckItemSummary))) &&
    (value.durationMs === undefined || typeof value.durationMs === 'number') &&
    (value.blockedBy === undefined || typeof value.blockedBy === 'string') &&
    (value.reason === undefined || typeof value.reason === 'string')
  );
}

function isLiminaCheckRunSummary(
  value: unknown,
): value is LiminaCheckRunSummary {
  return (
    isPlainRecord(value) &&
    typeof value.command === 'string' &&
    typeof value.createdAt === 'string' &&
    isLiminaCheckRunResult(value.result) &&
    Array.isArray(value.tasks) &&
    value.tasks.every(isLiminaCheckRunTaskSummary) &&
    (value.startedAt === undefined || typeof value.startedAt === 'string') &&
    (value.completedAt === undefined ||
      typeof value.completedAt === 'string') &&
    (value.durationMs === undefined || typeof value.durationMs === 'number') &&
    (value.configPath === undefined || typeof value.configPath === 'string') &&
    (value.pipeline === undefined || typeof value.pipeline === 'string') &&
    (value.blockedBy === undefined ||
      isLiminaCheckRunBlockedBy(value.blockedBy))
  );
}

function isLiminaCheckIssueLocation(
  value: unknown,
): value is LiminaCheckIssueLocation {
  return (
    isPlainRecord(value) &&
    (value.label === undefined || typeof value.label === 'string') &&
    (value.filePath === undefined || typeof value.filePath === 'string') &&
    (value.packageManifestPath === undefined ||
      typeof value.packageManifestPath === 'string') &&
    (value.scope === undefined || typeof value.scope === 'string') &&
    (value.line === undefined || typeof value.line === 'number') &&
    (value.column === undefined || typeof value.column === 'number')
  );
}

function isLiminaCheckIssueEvidence(
  value: unknown,
): value is LiminaCheckIssueEvidence {
  return (
    isPlainRecord(value) &&
    (value.label === undefined || typeof value.label === 'string') &&
    (value.value === undefined || typeof value.value === 'string') &&
    (value.lines === undefined || isStringArray(value.lines))
  );
}

function isLiminaCheckIssueExternal(
  value: unknown,
): value is LiminaCheckIssueExternal {
  return (
    isPlainRecord(value) &&
    (value.tool === undefined || typeof value.tool === 'string') &&
    (value.code === undefined || typeof value.code === 'string') &&
    (value.message === undefined || typeof value.message === 'string') &&
    (value.url === undefined || typeof value.url === 'string')
  );
}

function isSourceIssueSnapshotIssue(
  value: unknown,
): value is SourceIssueSnapshotIssue {
  return (
    isPlainRecord(value) &&
    typeof value.code === 'string' &&
    typeof value.ownerName === 'string' &&
    (value.filePath === undefined || typeof value.filePath === 'string')
  );
}

function isSourceUnusedWorkspaceDependencyIssue(
  issue: SourceCheckIssue,
): issue is SourceUnusedWorkspaceDependencyIssue {
  return (
    issue.code === LIMINA_CHECK_ISSUE_CODES.sourceUnusedWorkspaceDependency
  );
}

function isSourceUnusedModuleIssue(
  issue: SourceCheckIssue,
): issue is SourceUnusedModuleIssue {
  return issue.code === LIMINA_CHECK_ISSUE_CODES.sourceUnusedModule;
}

function isSourceIssueSnapshot(value: unknown): value is SourceIssueSnapshot {
  return (
    isPlainRecord(value) &&
    value.version === SOURCE_ISSUE_SNAPSHOT_VERSION &&
    typeof value.command === 'string' &&
    typeof value.createdAt === 'string' &&
    isSourceIssueSnapshotStatus(value.status) &&
    typeof value.legacyProblemCount === 'number' &&
    Array.isArray(value.issues) &&
    value.issues.every(isSourceIssueSnapshotIssue)
  );
}

function hasLiminaCheckIssueBaseFields(
  value: Record<string, unknown>,
): boolean {
  return (
    typeof value.task === 'string' &&
    typeof value.code === 'string' &&
    typeof value.title === 'string' &&
    typeof value.reason === 'string'
  );
}

function hasLiminaCheckIssueStructuredFields(
  value: Record<string, unknown>,
): boolean {
  return (
    (value.id === undefined || typeof value.id === 'string') &&
    (value.domain === undefined || typeof value.domain === 'string') &&
    (value.detector === undefined || typeof value.detector === 'string') &&
    (value.severity === undefined ||
      isLiminaCheckIssueSeverity(value.severity)) &&
    (value.summary === undefined || typeof value.summary === 'string') &&
    (value.fixSteps === undefined || isStringArray(value.fixSteps)) &&
    (value.verifyCommands === undefined ||
      isStringArray(value.verifyCommands)) &&
    (value.locations === undefined ||
      (Array.isArray(value.locations) &&
        value.locations.every(isLiminaCheckIssueLocation))) &&
    (value.evidence === undefined ||
      (Array.isArray(value.evidence) &&
        value.evidence.every(isLiminaCheckIssueEvidence))) &&
    (value.external === undefined || isLiminaCheckIssueExternal(value.external))
  );
}

function hasLiminaCheckIssueLegacyFields(
  value: Record<string, unknown>,
): boolean {
  return (
    (value.detailLines === undefined || isStringArray(value.detailLines)) &&
    (value.fix === undefined || typeof value.fix === 'string') &&
    (value.packageManifestPath === undefined ||
      typeof value.packageManifestPath === 'string') &&
    (value.packageName === undefined ||
      typeof value.packageName === 'string') &&
    (value.filePath === undefined || typeof value.filePath === 'string') &&
    (value.scope === undefined || typeof value.scope === 'string') &&
    (value.checkerName === undefined ||
      typeof value.checkerName === 'string') &&
    (value.tool === undefined || typeof value.tool === 'string')
  );
}

function isLiminaCheckIssue(value: unknown): value is LiminaCheckIssue {
  return (
    isPlainRecord(value) &&
    hasLiminaCheckIssueBaseFields(value) &&
    hasLiminaCheckIssueStructuredFields(value) &&
    hasLiminaCheckIssueLegacyFields(value)
  );
}

function isCheckIssueSnapshot(value: unknown): value is CheckIssueSnapshot {
  return (
    isPlainRecord(value) &&
    typeof value.version === 'number' &&
    SUPPORTED_CHECK_ISSUE_SNAPSHOT_VERSIONS.has(value.version) &&
    typeof value.command === 'string' &&
    typeof value.createdAt === 'string' &&
    isCheckIssueSnapshotStatus(value.status) &&
    Array.isArray(value.issues) &&
    value.issues.every(isLiminaCheckIssue) &&
    (value.run === undefined || isLiminaCheckRunSummary(value.run))
  );
}

function pluralIssue(count: number): string {
  return count === 1 ? 'issue' : 'issues';
}

function incrementCount(groups: Map<string, number>, key: string): void {
  groups.set(key, (groups.get(key) ?? 0) + 1);
}

function formatCountGroup(
  label: string,
  groups: Map<string, number>,
): string[] {
  const entries = [...groups.entries()].sort(
    ([leftName, leftCount], [rightName, rightCount]) =>
      rightCount - leftCount || leftName.localeCompare(rightName),
  );

  return [
    `${label}:`,
    ...(entries.length > 0
      ? entries.map(
          ([name, count]) => `  - ${name}  ${count} ${pluralIssue(count)}`,
        )
      : ['  (none)']),
  ];
}

function normalizeFilterValues(
  values: readonly string[] | undefined,
): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function normalizeFilePath(rootDir: string, filePath: string): string {
  return normalizeSlashes(
    path.isAbsolute(filePath) ? toRelativePath(rootDir, filePath) : filePath,
  );
}

function getIssueScope(issue: LiminaCheckIssue): string | undefined {
  if (issue.scope) {
    return issue.scope;
  }

  const filePath =
    issue.filePath ??
    issue.locations?.find((location) => location.filePath)?.filePath ??
    issue.packageManifestPath ??
    issue.locations?.find((location) => location.packageManifestPath)
      ?.packageManifestPath;

  if (!filePath) {
    return undefined;
  }

  const directory = path.posix.dirname(filePath);

  return directory === '.' ? '.' : directory;
}

function issueMatchesScope(issue: LiminaCheckIssue, scope: string): boolean {
  const issueScope = getIssueScope(issue);
  const filePaths = getIssueFilePaths(issue);

  return Boolean(
    issueScope &&
      (issueScope === scope ||
        issueScope.startsWith(`${scope}/`) ||
        filePaths.some(
          (filePath) => filePath === scope || filePath.startsWith(`${scope}/`),
        )),
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

function issueMatchesFilters(
  issue: LiminaCheckIssue,
  filters: CheckIssueInventoryFilters,
  rootDir?: string,
): boolean {
  const tasks = normalizeFilterValues(filters.tasks);
  const packages = normalizeFilterValues(filters.packageNames);
  const rules = normalizeFilterValues(filters.rules);
  const files = normalizeFilterValues(filters.files).map((filePath) =>
    rootDir ? normalizeFilePath(rootDir, filePath) : normalizeSlashes(filePath),
  );
  const scopes = normalizeFilterValues(filters.scopes);
  const checkers = normalizeFilterValues(filters.checkerNames);
  const issueFiles = getIssueFilePaths(issue);

  return (
    (tasks.length === 0 || tasks.includes(issue.task)) &&
    (packages.length === 0 ||
      (issue.packageName ? packages.includes(issue.packageName) : false)) &&
    (rules.length === 0 || rules.includes(issue.code)) &&
    (files.length === 0 ||
      issueFiles.some((filePath) => files.includes(filePath))) &&
    (scopes.length === 0 ||
      scopes.some((scope) => issueMatchesScope(issue, scope))) &&
    (checkers.length === 0 ||
      (issue.checkerName ? checkers.includes(issue.checkerName) : false))
  );
}

function createSnapshot(options: {
  command: string;
  issues: SourceIssueSnapshotIssue[];
  legacyProblemCount: number;
  status: SourceIssueSnapshotStatus;
}): SourceIssueSnapshot {
  return {
    command: options.command,
    createdAt: new Date().toISOString(),
    issues: options.issues,
    legacyProblemCount: options.legacyProblemCount,
    status: options.status,
    version: SOURCE_ISSUE_SNAPSHOT_VERSION,
  };
}

function toSnapshotIssue(
  rootDir: string,
  issue: SourceCheckIssue,
): SourceIssueSnapshotIssue {
  return {
    code: issue.code,
    ...('filePath' in issue && issue.filePath
      ? {
          filePath: normalizeSlashes(toRelativePath(rootDir, issue.filePath)),
        }
      : {}),
    ownerName: issue.ownerName,
  };
}

export function getSourceIssueSnapshotPath(rootDir: string): string {
  return path.join(
    rootDir,
    generatedRootDirName,
    'source-check',
    'last-run.json',
  );
}

export function getCheckIssueSnapshotPath(rootDir: string): string {
  return path.join(rootDir, generatedRootDirName, 'check', 'last-run.json');
}

export async function writeSourceIssueSnapshot(
  rootDir: string,
  snapshot: SourceIssueSnapshot,
): Promise<void> {
  const snapshotPath = getSourceIssueSnapshotPath(rootDir);

  await mkdir(path.dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
}

export async function writeCheckIssueSnapshot(
  rootDir: string,
  snapshot: CheckIssueSnapshot,
): Promise<void> {
  const snapshotPath = getCheckIssueSnapshotPath(rootDir);

  await mkdir(path.dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
}

export async function writeNotRunCheckIssueSnapshot(options: {
  command: string;
  rootDir: string;
  run?: LiminaCheckRunSummary;
}): Promise<void> {
  await writeCheckIssueSnapshot(options.rootDir, {
    command: options.command,
    createdAt: new Date().toISOString(),
    issues: [],
    run: options.run,
    status: 'not-run',
    version: CHECK_ISSUE_SNAPSHOT_VERSION,
  });
}

export async function writeCompletedCheckIssueSnapshot(options: {
  command: string;
  issues?: readonly LiminaCheckIssue[];
  rootDir: string;
  run?: LiminaCheckRunSummary;
}): Promise<void> {
  await writeCheckIssueSnapshot(options.rootDir, {
    command: options.command,
    createdAt: new Date().toISOString(),
    issues: [...(options.issues ?? [])],
    run: options.run,
    status: 'completed',
    version: CHECK_ISSUE_SNAPSHOT_VERSION,
  });
}

export async function completeCheckIssueSnapshot(options: {
  command?: string;
  rootDir: string;
  run?: LiminaCheckRunSummary;
}): Promise<void> {
  const current = await readCheckIssueSnapshot(options.rootDir);

  if (!current) {
    return;
  }

  await writeCompletedCheckIssueSnapshot({
    command: options.command ?? current?.command ?? 'limina check',
    issues: current?.issues ?? [],
    rootDir: options.rootDir,
    run: options.run ?? current.run,
  });
}

export async function appendCheckIssues(options: {
  command?: string;
  issues: readonly LiminaCheckIssue[];
  rootDir: string;
}): Promise<void> {
  if (options.issues.length === 0) {
    return;
  }

  const current = await readCheckIssueSnapshot(options.rootDir);

  await writeCompletedCheckIssueSnapshot({
    command: options.command ?? current?.command ?? 'limina check',
    issues: [...(current?.issues ?? []), ...options.issues],
    rootDir: options.rootDir,
    run: current?.run,
  });
}

export async function appendTaskFailureIssueIfMissing(options: {
  command?: string;
  issue: LiminaCheckIssue;
  rootDir: string;
}): Promise<void> {
  const current = await readCheckIssueSnapshot(options.rootDir);

  if (current?.issues.some((issue) => issue.task === options.issue.task)) {
    return;
  }

  await appendCheckIssues({
    command: options.command,
    issues: [options.issue],
    rootDir: options.rootDir,
  });
}

export async function writeNotRunSourceIssueSnapshot(options: {
  command: string;
  rootDir: string;
}): Promise<void> {
  await writeSourceIssueSnapshot(
    options.rootDir,
    createSnapshot({
      command: options.command,
      issues: [],
      legacyProblemCount: 0,
      status: 'not-run',
    }),
  );
}

export async function writeCompletedSourceIssueSnapshot(options: {
  appendCheckIssues?: boolean;
  command: string;
  issues: readonly SourceCheckIssue[];
  legacyProblems: readonly string[];
  rootDir: string;
}): Promise<void> {
  await writeSourceIssueSnapshot(
    options.rootDir,
    createSnapshot({
      command: options.command,
      issues: options.issues.map((issue) =>
        toSnapshotIssue(options.rootDir, issue),
      ),
      legacyProblemCount: options.legacyProblems.length,
      status: 'completed',
    }),
  );

  if (options.appendCheckIssues ?? true) {
    await appendCheckIssues({
      command: options.command,
      issues: options.issues.map((issue) =>
        createSourceCheckIssue({
          issue,
          rootDir: options.rootDir,
        }),
      ),
      rootDir: options.rootDir,
    });
  }
}

export async function readSourceIssueSnapshot(
  rootDir: string,
): Promise<SourceIssueSnapshot | null> {
  const snapshotPath = getSourceIssueSnapshotPath(rootDir);

  if (!existsSync(snapshotPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(await readFile(snapshotPath, 'utf8')) as unknown;

    return isSourceIssueSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function readCheckIssueSnapshot(
  rootDir: string,
): Promise<CheckIssueSnapshot | null> {
  const snapshotPath = getCheckIssueSnapshotPath(rootDir);

  if (!existsSync(snapshotPath)) {
    const sourceSnapshot = await readSourceIssueSnapshot(rootDir);

    return sourceSnapshot
      ? sourceSnapshotToCheckSnapshot(sourceSnapshot)
      : null;
  }

  try {
    const parsed = JSON.parse(await readFile(snapshotPath, 'utf8')) as unknown;

    return isCheckIssueSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function createTaskFailureIssue(options: {
  checkerName?: string;
  code?: string;
  detector?: string;
  detailLines?: readonly string[];
  domain?: string;
  evidence?: readonly LiminaCheckIssueEvidence[];
  external?: LiminaCheckIssueExternal;
  filePath?: string;
  fix?: string;
  fixSteps?: readonly string[];
  id?: string;
  locations?: readonly LiminaCheckIssueLocation[];
  packageManifestPath?: string;
  packageName?: string;
  reason?: string;
  rootDir: string;
  scope?: string;
  severity?: LiminaCheckIssueSeverity;
  summary?: string;
  task: LiminaCheckTaskName;
  title?: string;
  tool?: string;
  verifyCommands?: readonly string[];
}): LiminaCheckIssue {
  return createLiminaCheckIssue(options);
}

export function createSourceCheckIssue(options: {
  issue: SourceCheckIssue;
  rootDir: string;
}): LiminaCheckIssue {
  if (isSourceUnusedModuleIssue(options.issue)) {
    return createLiminaCheckIssue({
      code: options.issue.code,
      detector: 'knip',
      domain: 'source',
      filePath: options.issue.filePath,
      fixSteps: [
        'Delete files that are truly unused.',
        'Make files reachable from package manifest entries, binaries, scripts, or Knip plugin entries.',
        `Add intentional files to source.knip.workspaces["${options.issue.ownerName}"].ignoreFiles with a reason.`,
      ],
      packageManifestPath: options.issue.packageJsonPath,
      packageName: options.issue.ownerName,
      reason:
        'Owner-governed source modules must be reachable from package entries, binaries, scripts, or Knip plugin entries.',
      rootDir: options.rootDir,
      summary:
        'Unused source module is not reachable from package entry points.',
      task: 'source:check',
      title: 'Unused source module',
      tool: 'knip',
      verifyCommands: ['limina source check'],
    });
  }

  if (isSourceUnusedWorkspaceDependencyIssue(options.issue)) {
    return createLiminaCheckIssue({
      code: options.issue.code,
      detector: 'knip',
      domain: 'source',
      evidence: [
        {
          label: 'dependency',
          value: `${options.issue.dependencyName} (${options.issue.sectionName}: ${options.issue.specifier})`,
        },
      ],
      fixSteps: [
        'Remove dependencies that are truly unused from the package manifest.',
        'Make dependencies reachable from package entries, binaries, scripts, or Knip plugin entries.',
        `Add intentional dependencies to source.knip.workspaces["${options.issue.ownerName}"].ignoreDependencies with dep and reason.`,
      ],
      packageManifestPath: options.issue.packageJsonPath,
      packageName: options.issue.ownerName,
      reason:
        'Workspace package dependencies must be reachable from package entries, binaries, scripts, or explicitly ignored when usage is not visible to Knip analysis.',
      rootDir: options.rootDir,
      summary:
        'Workspace package dependency is not visible to source analysis.',
      task: 'source:check',
      title: 'Unused workspace dependency',
      tool: 'knip',
      verifyCommands: ['limina source check'],
    });
  }

  return createLiminaCheckIssue({
    code: options.issue.code,
    detector: options.issue.detector,
    detailLines: options.issue.detailLines,
    domain: 'source',
    evidence: options.issue.evidence,
    filePath: options.issue.filePath,
    fix: options.issue.fix,
    fixSteps: options.issue.fixSteps,
    locations: options.issue.locations,
    packageManifestPath: options.issue.packageJsonPath,
    packageName: options.issue.ownerName,
    reason: options.issue.reason,
    rootDir: options.rootDir,
    scope: options.issue.scope,
    summary: options.issue.summary,
    task: 'source:check',
    title: options.issue.title,
    tool: options.issue.tool,
    verifyCommands: options.issue.verifyCommands,
  });
}

function sourceSnapshotToCheckSnapshot(
  snapshot: SourceIssueSnapshot,
): CheckIssueSnapshot {
  return {
    command: snapshot.command,
    createdAt: snapshot.createdAt,
    issues: snapshot.issues.map((issue) => {
      const filePath = issue.filePath
        ? normalizeSlashes(issue.filePath)
        : undefined;

      return createLiminaCheckIssue({
        code: issue.code,
        filePath,
        packageName: issue.ownerName,
        reason:
          issue.code === LIMINA_CHECK_ISSUE_CODES.sourceUnusedModule
            ? 'Owner-governed source modules must be reachable from package entries, binaries, scripts, or Knip plugin entries.'
            : 'Workspace package dependencies must be reachable from package entries, binaries, scripts, or explicitly ignored when usage is not visible to Knip analysis.',
        rootDir: '.',
        task: 'source:check',
        title:
          issue.code === LIMINA_CHECK_ISSUE_CODES.sourceUnusedModule
            ? 'Unused source module'
            : 'Unused workspace dependency',
      });
    }),
    status: snapshot.status,
    version: CHECK_ISSUE_SNAPSHOT_VERSION,
  };
}

function createInventoryPayload(options: {
  filteredIssues: readonly LiminaCheckIssue[];
  filters: CheckIssueInventoryFilters;
  snapshot: CheckIssueSnapshot | null;
}): Record<string, unknown> {
  return {
    command: options.snapshot?.command,
    createdAt: options.snapshot?.createdAt,
    filters: options.filters,
    issueCount: options.filteredIssues.length,
    issues: options.filteredIssues,
    overview: createIssueOverview(options.filteredIssues),
    run: options.snapshot?.run,
    status: options.snapshot?.status ?? 'missing',
    topBlockers: selectTopBlockers(options.filteredIssues),
    version: options.snapshot?.version,
  };
}

function formatJsonInventory(options: {
  filteredIssues: readonly LiminaCheckIssue[];
  filters: CheckIssueInventoryFilters;
  snapshot: CheckIssueSnapshot | null;
}): string {
  return JSON.stringify(createInventoryPayload(options), null, 2);
}

function formatNdjsonInventory(issues: readonly LiminaCheckIssue[]): string {
  return issues.map((issue) => JSON.stringify(issue)).join('\n');
}

export function formatCheckIssueSnapshotInventory(
  options: CheckIssueInventoryOptions,
): string {
  const filters = options.filters ?? {};
  const format = options.format ?? 'human';

  if (!options.snapshot) {
    if (format === 'json') {
      return formatJsonInventory({
        filteredIssues: [],
        filters,
        snapshot: null,
      });
    }

    if (format === 'ndjson') {
      return '';
    }

    return [
      'No check issue snapshot found.',
      'Run `limina check` first, then run `limina check --issues`.',
    ].join('\n');
  }

  if (options.snapshot.status !== 'completed') {
    if (format === 'json') {
      return formatJsonInventory({
        filteredIssues: [],
        filters,
        snapshot: options.snapshot,
      });
    }

    if (format === 'ndjson') {
      return '';
    }

    return [
      'No completed check issue snapshot is available from the last run.',
      'Run `limina check` and let it reach a failing or completed task first.',
    ].join('\n');
  }

  const filteredIssues = options.snapshot.issues.filter((issue) =>
    issueMatchesFilters(issue, filters, options.rootDir),
  );
  const issueSummary = formatCheckIssueSnapshotSummaryHuman({
    filteredIssueCount: filteredIssues.length,
    filters,
    issues: filteredIssues,
    rootDir: options.rootDir,
    snapshot: options.snapshot,
    totalIssueCount: options.snapshot.issues.length,
  });

  if (format === 'json') {
    return formatJsonInventory({
      filteredIssues,
      filters,
      snapshot: options.snapshot,
    });
  }

  if (format === 'ndjson') {
    return formatNdjsonInventory(filteredIssues);
  }

  if (options.verbose) {
    return [
      issueSummary,
      '',
      formatCheckIssueHumanReport({
        command: options.snapshot.command,
        issues: filteredIssues,
        title: 'Check issue details',
        verbose: true,
      }),
    ].join('\n');
  }

  return issueSummary;
}

export function formatSourceIssueSnapshotInventory(
  snapshot: SourceIssueSnapshot | null,
): string {
  if (!snapshot) {
    return [
      'No source issue snapshot found.',
      'Run `limina check` first, then run `limina check --issues`.',
    ].join('\n');
  }

  if (snapshot.status !== 'completed') {
    return [
      'No completed source issue snapshot is available from the last run.',
      'Run `limina check` and let it reach source:check first.',
    ].join('\n');
  }

  if (snapshot.issues.length === 0) {
    return [
      'No source issue filters are available from the last run.',
      snapshot.legacyProblemCount > 0
        ? `The last source check reported ${snapshot.legacyProblemCount} unfilterable ${pluralIssue(snapshot.legacyProblemCount)}.`
        : 'The last source check completed without structured source issues.',
      'If `limina check` failed later, that failure came from another task and cannot be filtered with source issue flags.',
    ].join('\n');
  }

  const packages = new Map<string, number>();
  const rules = new Map<string, number>();
  const scopes = new Map<string, number>();

  for (const issue of snapshot.issues) {
    incrementCount(packages, issue.ownerName);
    incrementCount(rules, issue.code);

    if (issue.filePath) {
      const directory = path.posix.dirname(issue.filePath);

      incrementCount(scopes, directory === '.' ? '.' : directory);
    }
  }

  return [
    'Issue filters available from last run:',
    '',
    ...formatCountGroup('packages', packages),
    '',
    ...formatCountGroup('rules', rules),
    '',
    ...formatCountGroup('scopes', scopes),
  ].join('\n');
}
