import type { ResolvedLiminaConfig } from '#config/runner';
import type { AnalysisProviderSet } from '#core';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type { LiminaCheckIssue } from '../check-reporting/snapshot';
import type { TaskProgressReporter } from '../execution/progress';
import type { LiminaCheckRunTaskStats } from '../execution/run-recorder';
import type { LiminaFlowReporter } from '../flow';
import type { LiminaPreflightManager } from '../preflight';
import type { KnipCliRunner } from './knip';
import type { SourceCheckIssue, SourceIssueReportOptions } from './report';

export interface RunSourceCheckOptions {
  clearScreen?: boolean;
  providers?: AnalysisProviderSet;
  deferSnapshot?: boolean;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
  issues?: LiminaCheckIssue[];
  knipRunner?: KnipCliRunner;
  resolveKnipCliPath?: () => string;
  onStats?: (stats: LiminaCheckRunTaskStats) => void;
  onSourceSnapshot?: (issues: readonly SourceCheckIssue[]) => void;
  preflight?: LiminaPreflightManager;
  progress?: TaskProgressReporter;
  report?: SourceIssueReportOptions;
  sourceIssues?: SourceCheckIssue[];
}

export interface RunSourceCheckImplOptions extends RunSourceCheckOptions {
  config?: ResolvedLiminaConfig;
  logSuccess?: boolean;
}

export const SOURCE_CHECK_ITEM_NAMES = [
  'source graph routes',
  'tsconfig governance',
  'knip source usage',
  'source project ownership',
  'source import authority',
] as const;
