import type {
  PackageAttwProfile,
  PackageCheckTool,
  PackageCheckToolSelection,
  PackageEntry,
  ResolvedLiminaConfig,
  RuntimeEnvironment,
} from '#config/runner';
import type { AnalysisProviderSet } from '#core';
import type { CheckIssueReportOptions } from '../check-reporting/human';
import type { LiminaCheckRunTaskStats } from '../check-reporting/run-recorder';
import type { LiminaCheckIssue } from '../check-reporting/snapshot';
import type {
  TaskProgressItem,
  TaskProgressReporter,
} from '../execution/progress';
import type { LiminaFlowReporter } from '../flow';
import type { LiminaPreflightManager } from '../preflight';

export interface PublishedPackageBoundaryTarget {
  outDir: string;
  environment?:
    | RuntimeEnvironment
    | ((relativeFilePath: string) => RuntimeEnvironment);
  ignoredExternalPackages?: string[];
}

export interface PublishedPackageBoundaryViolation {
  environment: RuntimeEnvironment;
  filePath: string;
  message: string;
  specifier: string;
}

export interface PackedPackageTarball {
  cleanup: () => Promise<void>;
  tarball: Buffer;
  tarballPath: string;
}

export interface RunPackageCheckOptions {
  attwProfile?: PackageAttwProfile;
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
  tool?: PackageCheckToolSelection;
}

export interface PackageCheckEntryRunResult {
  checkedToolCount: number;
  durationMs: number;
  issues: LiminaCheckIssue[];
  label: string;
  passed: boolean;
  skippedToolCount: number;
}

export type PackageToolCheckResult = 'failed' | 'passed' | 'skipped';

export interface RunPackageCheckEntryOptions {
  attwProfile?: PackageAttwProfile;
  checks: PackageCheckTool[];
  config: ResolvedLiminaConfig;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  issueSink?: LiminaCheckIssue[];
  label: string;
  outDir: string;
  progressItem?: TaskProgressItem;
  rawEntry: PackageEntry;
}

export interface ToolCheckContext {
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  issueSink?: LiminaCheckIssue[];
  label: string;
  packageManifestPath: string;
  packageName?: string;
  rootDir: string;
}
