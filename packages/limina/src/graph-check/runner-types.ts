import type { AnalysisProviderSet } from '#core';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type { CheckIssueReportOptions } from '../check-reporting/human';
import type { LiminaCheckRunTaskStats } from '../check-reporting/run-recorder';
import type { LiminaCheckIssue } from '../check-reporting/snapshot';
import type { DependencyGraphView } from '../dependency-graph/runner';
import type { TaskProgressReporter } from '../execution/progress';
import type { LiminaFlowReporter } from '../flow';
import type { LiminaPreflightManager } from '../preflight';

export interface RunGraphCheckOptions {
  clearScreen?: boolean;
  providers?: AnalysisProviderSet;
  deferSnapshot?: boolean;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
  issues?: LiminaCheckIssue[];
  onStats?: (stats: LiminaCheckRunTaskStats) => void;
  preflight?: LiminaPreflightManager;
  progress?: TaskProgressReporter;
  report?: CheckIssueReportOptions;
}

export interface RunGraphCheckImplOptions {
  providers?: AnalysisProviderSet;
  generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
  issues?: LiminaCheckIssue[];
  logSuccess?: boolean;
  onStats?: (stats: LiminaCheckRunTaskStats) => void;
  preflight?: LiminaPreflightManager;
  progress?: TaskProgressReporter;
  report?: CheckIssueReportOptions;
}

export interface RunGraphPrepareOptions {
  clearScreen?: boolean;
  providers?: AnalysisProviderSet;
  deferSnapshot?: boolean;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
  issues?: LiminaCheckIssue[];
  preflight?: LiminaPreflightManager;
  progress?: TaskProgressReporter;
  report?: CheckIssueReportOptions;
}

export interface RunGraphExportOptions {
  preflight?: LiminaPreflightManager;
  providers?: AnalysisProviderSet;
  outputPath?: string;
  view?: DependencyGraphView;
}

export const GRAPH_CHECK_ITEM_NAMES = [
  'source graph routes',
  'project references',
  'condition domains',
  'reference completeness',
] as const;
