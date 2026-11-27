import type {
  PackageCheckToolSelection,
  ResolvedLiminaConfig,
} from '#config/runner';
import type { AnalysisProviderSet, SubscriptionPlan } from '#core';
import type {
  GeneratedTsconfigGraphResult,
  PreparedTsconfigGraph,
} from '#core/build-graph/runner';
import type { AnalysisMetricsRecorder } from '../application/analysis/analysis-run';
import type { AnalysisBlockReadFilter } from '../core/analysis-cache/snapshot-shards';
import type { LiminaPreflightManager } from './manager';

export interface LiminaPreflightManagerOptions {
  analysisCache?: boolean | 'read-only';
  cacheBlockReadFilter?: AnalysisBlockReadFilter;
  forceAnalysisCache?: boolean;
  config: ResolvedLiminaConfig;
  generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
  metrics?: AnalysisMetricsRecorder;
  providers?: AnalysisProviderSet;
  signal?: AbortSignal;
  subscriptionPlan?: SubscriptionPlan;
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

export interface MaterializationReceipt<
  G extends PreparedTsconfigGraph = PreparedTsconfigGraph,
> {
  changed: boolean;
  generation: number;
  graph: G;
}
