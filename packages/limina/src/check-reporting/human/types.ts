import type { CheckIssueInventoryView } from '../inventory-presentation';
import type { LiminaCheckIssue, LiminaCheckIssueExternal } from '../snapshot';

export interface CheckIssueReportOptions {
  command?: string;
  defer?: boolean;
  verbose?: boolean;
}

export interface CheckIssueHumanReportOptions extends CheckIssueReportOptions {
  color: boolean;
  detailLimit?: number;
  issues: readonly LiminaCheckIssue[];
  title: string;
}

export interface CheckIssueInventoryCardOptions {
  color: boolean;
  issue: LiminaCheckIssue;
  representativeLocation: string | undefined;
  view: Exclude<CheckIssueInventoryView, 'summary'>;
}

export interface IssueGroup {
  checkerName?: string;
  code: string;
  detector?: string;
  domain?: string;
  external?: LiminaCheckIssueExternal;
  fix?: string;
  fixSteps?: string[];
  issues: LiminaCheckIssue[];
  packageManifestPath?: string;
  packageName?: string;
  reason: string;
  severity?: string;
  summary?: string;
  task: string;
  title: string;
  tool?: string;
  verifyCommands?: string[];
}
