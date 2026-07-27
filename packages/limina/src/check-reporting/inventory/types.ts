import type { ShellCommandDialect } from '../shell-command';
import type {
  CheckIssueInventoryFilters,
  LiminaCheckIssue,
  LiminaCheckIssueSeverity,
} from '../snapshot';

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

export type RootCauseTuple = readonly [
  task: string,
  code: string,
  title: string,
  checkerName: string,
  tool: string,
  domain: string,
  detector: string,
];

export interface MutableHumanPrimaryBlocker {
  files: Set<string>;
  issues: LiminaCheckIssue[];
  key: string;
  packageCounts: Map<string, number>;
}
