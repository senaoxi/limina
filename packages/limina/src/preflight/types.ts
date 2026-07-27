import type {
  PackageCheckToolSelection,
  ResolvedLiminaConfig,
} from '#config/runner';
import type { AnalysisProviderSet } from '#core';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type { AnalysisMetricsRecorder } from '../application/analysis/analysis-run';
import type { LiminaPreflightManager } from './manager';

export interface LiminaPreflightManagerOptions {
  config: ResolvedLiminaConfig;
  generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
  metrics?: AnalysisMetricsRecorder;
  providers?: AnalysisProviderSet;
  signal?: AbortSignal;
}

export interface PackageEntryPlanOptions {
  cwd: string;
  packageNames?: readonly string[];
  requireCwdPackageMatch: boolean;
  tool?: PackageCheckToolSelection;
}

export interface PreflightCapableOptions {
  generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
  preflight?: LiminaPreflightManager;
  providers?: AnalysisProviderSet;
}

export interface MaterializationReceipt {
  changed: boolean;
  generation: number;
  graph: GeneratedTsconfigGraphResult;
}
