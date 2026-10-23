import type { CheckerPackageResolver } from '#checkers';
import type { BuildCheckerPreset, ResolvedLiminaConfig } from '#config/runner';
import type { AnalysisProviderSet } from '#core';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type { CheckIssueReportOptions } from '../check-reporting/human';
import type { TaskProgressReporter } from '../execution/progress';
import type { LiminaFlowReporter } from '../flow';
import type { LiminaPreflightManager } from '../preflight';
import type { ExecutionAdmission } from './admission/execution-admission';
import type { ExecutionAdmissionRejection } from './admission/types';
import type {
  CheckerTargetId,
  CheckerTargetOutcome,
  TypecheckRunner,
  TypecheckTargetResult,
} from './targets';

export interface RunCheckerBuildOptions {
  clearScreen?: boolean;
  checker?: BuildCheckerPreset;
  configPath?: string;
  config: ResolvedLiminaConfig;
  providers?: AnalysisProviderSet;
  cwd?: string;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
  preflight?: LiminaPreflightManager;
  progress?: TaskProgressReporter;
  report?: CheckIssueReportOptions;
  checkerPackageResolver?: CheckerPackageResolver;
  runner?: TypecheckRunner;
  tscCommand?: string;
  watch?: boolean;
}

export interface CheckerFailureTarget {
  blockedByTarget?: readonly CheckerTargetId[];
  checkerName?: string;
  configPath: string;
  exitCode?: number;
  admission?: ExecutionAdmissionRejection;
  id?: CheckerTargetId;
  message?: string;
}

export type CheckerFailureKind =
  | 'execution-admission'
  | 'peer-dependency'
  | 'process'
  | 'target-selection';

export interface RunCheckerBuildResult {
  failedTargets: CheckerFailureTarget[];
  failureKind?: CheckerFailureKind;
  passed: boolean;
  problems?: string[];
  projectRootDir: string;
  rootConfigPaths: string[];
  targetResults: TypecheckTargetResult[];
  targetOutcomes?: CheckerTargetOutcome[];
}

export interface CheckerBuildExecutionResult {
  admission: ExecutionAdmission;
  failureKind?: CheckerFailureKind;
  failedResults: TypecheckTargetResult[];
  failedTargets: CheckerFailureTarget[];
  passed: boolean;
  results: TypecheckTargetResult[];
  targetOutcomes: CheckerTargetOutcome[];
}

export interface RunBuildOptions {
  clearScreen?: boolean;
  checker?: BuildCheckerPreset;
  configPath?: string;
  config: ResolvedLiminaConfig;
  providers?: AnalysisProviderSet;
  cwd?: string;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
  preflight?: LiminaPreflightManager;
  report?: CheckIssueReportOptions;
  checkerPackageResolver?: CheckerPackageResolver;
  project?: string;
  raw?: boolean;
  runner?: TypecheckRunner;
  tscCommand?: string;
  watch?: boolean;
}

export interface RunBuildResult {
  targetResults?: TypecheckTargetResult[];
  targetOutcomes?: CheckerTargetOutcome[];
  failedTargets: CheckerFailureTarget[];
  failureKind?: CheckerFailureKind;
  passed: boolean;
  problems?: string[];
  projectRootDir: string;
  rootConfigPaths: string[];
  sourceConfigPath: string | null;
}

export interface RunCheckerTypecheckOptions {
  clearScreen?: boolean;
  config: ResolvedLiminaConfig;
  providers?: AnalysisProviderSet;
  cwd?: string;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
  preflight?: LiminaPreflightManager;
  progress?: TaskProgressReporter;
  report?: CheckIssueReportOptions;
  signal?: AbortSignal;
  checkerPackageResolver?: CheckerPackageResolver;
  runner?: TypecheckRunner;
  tscCommand?: string;
}

export interface RunCheckerTypecheckResult {
  targetOutcomes?: CheckerTargetOutcome[];
  checkerNames?: string[];
  failedTargets: CheckerFailureTarget[];
  disabled: boolean;
  failureKind?: CheckerFailureKind;
  passed: boolean;
  problems?: string[];
  projectRootDir: string;
  rootConfigPaths: string[];
  targetResults: TypecheckTargetResult[];
}
