import type { LiminaWritableCheckIssueCode } from '../../check-reporting/codes';
import type {
  CheckIssueInventoryPresentationOptions,
  InventoryQueryContext,
} from '../../check-reporting/inventory-presentation';
import type { SourceIssueCode } from '../report';

export const SOURCE_ISSUE_SNAPSHOT_VERSION = 1;
export const CHECK_ISSUE_SNAPSHOT_VERSION = 8;

export const LIMINA_CHECK_TASK_NAMES = [
  'checker:build',
  'checker:typecheck',
  'command',
  'graph:check',
  'graph:materialize',
  'graph:prepare',
  'package:check',
  'proof:check',
  'release:check',
  'source:check',
  'workspace:validate',
] as const;

export type LiminaCheckTaskName = (typeof LIMINA_CHECK_TASK_NAMES)[number];
export type SourceIssueSnapshotStatus = 'completed' | 'not-run';
export type CheckIssueSnapshotStatus = 'completed' | 'not-run';
export type LiminaCheckIssueSeverity = 'error' | 'info' | 'warning';
export type LiminaCheckRunResult =
  | 'blocked'
  | 'failed'
  | 'not-run'
  | 'passed'
  | 'running';
export type LiminaCheckRunTaskKind = 'command' | 'preparation' | 'task';
export type LiminaCheckRunTaskStatus =
  | 'blocked'
  | 'disabled'
  | 'failed'
  | 'passed'
  | 'planned'
  | 'running'
  | 'skipped';
export type LiminaCheckRunCheckItemStatus =
  | 'blocked'
  | 'failed'
  | 'disabled'
  | 'passed'
  | 'skipped';

export interface LiminaCheckRunBlockedBy {
  id: string;
  label: string;
}

export interface CheckItemStatistics {
  checksPassed?: number;
  checksTotal?: number;
  durationMs?: number;
  issues?: number;
  name: string;
  status: LiminaCheckRunCheckItemStatus;
}

export interface ValidationCheckItemSnapshot extends CheckItemStatistics {
  itemKind: 'check';
}

export interface CheckerTargetCheckItemSnapshot extends CheckItemStatistics {
  blockedBy?: readonly { id: string; name: string }[];
  id: string;
  itemKind: 'checker-target';
}

export type LiminaCheckRunCheckItemSummary =
  | ValidationCheckItemSnapshot
  | CheckerTargetCheckItemSnapshot;

export interface LiminaCheckRunTaskSummary {
  blockedBy?: { id: string; label: string };
  checkItems?: LiminaCheckRunCheckItemSummary[];
  checksPassed?: number;
  checksTotal?: number;
  completedAt?: string;
  durationMs?: number;
  generation: number;
  id: string;
  issueTask: LiminaCheckTaskName;
  kind: LiminaCheckRunTaskKind;
  label: string;
  reason?: string;
  startedAt?: string;
  state: LiminaCheckRunTaskStatus;
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

export interface CanonicalLiminaCheckIssue extends LiminaCheckIssue {
  code: LiminaWritableCheckIssueCode;
}

export interface CheckIssueSnapshot {
  command: string;
  createdAt: string;
  issues: LiminaCheckIssue[];
  run?: LiminaCheckRunSummary;
  status: CheckIssueSnapshotStatus;
  version: typeof CHECK_ISSUE_SNAPSHOT_VERSION;
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

interface CheckIssueInventoryBaseOptions {
  invocation?: CheckIssueInventoryInvocationMetadata;
  rootDir?: string;
  snapshot: CheckIssueSnapshot | null;
}

export interface CheckIssueInventoryHumanOptions
  extends CheckIssueInventoryBaseOptions {
  color: boolean;
  filters?: never;
  format?: 'human';
  presentation: CheckIssueInventoryPresentationOptions;
  queryContext: InventoryQueryContext;
}

export interface CheckIssueInventoryMachineOptions
  extends CheckIssueInventoryBaseOptions {
  filters?: CheckIssueInventoryFilters;
  format: Exclude<CheckIssueInventoryFormat, 'human'>;
  presentation?: never;
  queryContext?: never;
}

export type CheckIssueInventoryOptions =
  | CheckIssueInventoryHumanOptions
  | CheckIssueInventoryMachineOptions;

export interface CheckIssueInventoryInvocationMetadata {
  completedAt: string;
  invocationId: string;
  kind: 'standalone-invocation';
  result: 'failed';
  version: number;
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
  status: SourceIssueSnapshotStatus;
  version: typeof SOURCE_ISSUE_SNAPSHOT_VERSION;
}
