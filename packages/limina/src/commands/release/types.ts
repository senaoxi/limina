import type { ResolvedLiminaConfig } from '#config/runner';
import type { AnalysisProviderSet } from '#core';
import type { WorkspacePackage } from '#core/workspace/actions';
import type { CheckIssueReportOptions } from '../../check-reporting/human';
import type { LiminaCheckRunTaskStats } from '../../check-reporting/run-recorder';
import type { LiminaCheckIssue } from '../../check-reporting/snapshot';
import type {
  TaskProgressItem,
  TaskProgressReporter,
} from '../../execution/progress';
import type { LiminaFlowReporter } from '../../flow';
import type { PackageEntrySelectionPlan } from '../../package-check/runner';
import type { LiminaPreflightManager } from '../../preflight';

export interface RunReleaseCheckOptions {
  clearScreen?: boolean;
  config: ResolvedLiminaConfig;
  providers?: AnalysisProviderSet;
  cwd?: string;
  deferSnapshot?: boolean;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  issues?: LiminaCheckIssue[];
  onStats?: (stats: LiminaCheckRunTaskStats) => void;
  packageNames?: readonly string[];
  preflight?: LiminaPreflightManager;
  progress?: TaskProgressReporter;
  report?: CheckIssueReportOptions;
}

export interface ReleaseEntryOptions {
  config: ResolvedLiminaConfig;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  issueSink?: LiminaCheckIssue[];
  label: string;
  outDir: string;
  progressItem?: TaskProgressItem;
  workspacePackages: readonly WorkspacePackage[];
}

export interface ReleaseCheckEntryRunResult {
  durationMs: number;
  issues: LiminaCheckIssue[];
  label: string;
  passed: boolean;
}

export type ReleasePlanEntry = PackageEntrySelectionPlan['entries'][number];
