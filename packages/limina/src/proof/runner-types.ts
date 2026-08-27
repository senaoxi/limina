import type { ResolvedCheckerConfig } from '#config/runner';
import type { AnalysisProviderSet } from '#core';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type { CheckIssueReportOptions } from '../check-reporting/human';
import type { LiminaCheckRunTaskStats } from '../check-reporting/run-recorder';
import type { LiminaCheckIssue } from '../check-reporting/snapshot';
import type { TaskProgressReporter } from '../execution/progress';
import type { LiminaFlowReporter } from '../flow';
import type { LiminaPreflightManager } from '../preflight';
import type { ProofFinding } from './findings';

export interface CheckerCoverageTarget {
  checker: ResolvedCheckerConfig;
  configPath: string;
  coverageConfigPaths: string[];
  label: string;
}

export interface CheckerCoverageTargetCollection {
  findings: ProofFinding[];
  targets: CheckerCoverageTarget[];
}

export interface ProofPackageIdentity {
  packageManifestPath?: string;
  packageName?: string;
}

export interface ConfigFileOwner {
  checkerEntryPath: string;
  checkerName: string;
  checkerPreset: ResolvedCheckerConfig['name'];
  configPath: string;
}

export type ConfigFileOwners = Map<string, ConfigFileOwner[]>;

export interface RunProofCheckOptions {
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

export interface RunProofCheckImplOptions {
  providers?: AnalysisProviderSet;
  deferSnapshot?: boolean;
  findingSink?: ProofFinding[];
  generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
  issues?: LiminaCheckIssue[];
  logSuccess?: boolean;
  onStats?: (stats: LiminaCheckRunTaskStats) => void;
  preflight?: LiminaPreflightManager;
  progress?: TaskProgressReporter;
  report?: CheckIssueReportOptions;
}

export const PROOF_CHECK_ITEM_NAMES = [
  'project routes and configs',
  'checker coverage targets',
  'proof allowlist',
  'source coverage',
] as const;
