import { randomUUID } from 'node:crypto';
import type {
  AnalysisGeneration,
  AnalysisRunId,
  RepositorySnapshotToken,
} from '../../domain/shared/identifiers';
import { identifier } from '../../domain/shared/identifiers';

export type AnalysisMetricName =
  | 'artifact-mutation'
  | 'artifact-safety-immediate-recheck'
  | 'artifact-safety-lstat'
  | 'artifact-safety-unique-node'
  | 'canonical-path-cache-hit'
  | 'canonical-path-cache-miss'
  | 'canonical-path'
  | 'checker-route-projection'
  | 'checker-route-traversal'
  | 'import-resolution-cache-hit'
  | 'import-resolution-cache-miss'
  | 'internal-import-resolution'
  | 'module-resolution-index-hit'
  | 'module-resolution-index-miss'
  | 'module-resolution-request'
  | 'oxc-resolution'
  | 'oxc-resolver-factory-create'
  | 'oxc-resolver-factory-hit'
  | 'provider-cache-hit'
  | 'provider-cache-miss'
  | 'projection'
  | 'source-parse'
  | 'source-read'
  | 'typescript-module-resolution-cache-hit'
  | 'typescript-module-resolution-cache-miss'
  | 'typescript-resolution'
  | 'workspace-directory-index-entry'
  | 'workspace-export-grouped-oxc-execution'
  | 'workspace-export-grouped-typescript-execution'
  | 'workspace-export-oxc-resolution'
  | 'workspace-export-oxc-semantic-profile-count'
  | 'workspace-export-profile-count'
  | 'workspace-export-resolution-request'
  | 'workspace-export-result-expansion'
  | 'workspace-export-typescript-profile-fallback'
  | 'workspace-export-typescript-resolution'
  | 'workspace-export-typescript-semantic-profile-count'
  | 'workspace-importer-ancestor-visit'
  | 'workspace-negative-lookup'
  | 'workspace-path-ancestor-visit'
  | 'workspace-path-classification-hit'
  | 'workspace-path-classification-miss'
  | 'validator';

export interface AnalysisMetricMeasurement {
  readonly count?: number;
  readonly durationMs?: number;
  readonly estimatedBytes?: number;
  readonly kind?: string;
  readonly name: AnalysisMetricName;
  readonly provider?: string;
  readonly reports?: number;
}

export interface AnalysisMetricsRecorder {
  record(measurement: AnalysisMetricMeasurement): void;
}

export interface AnalysisRun {
  readonly generation: AnalysisGeneration;
  readonly id: AnalysisRunId;
  readonly metrics: AnalysisMetricsRecorder;
  readonly signal: AbortSignal;
  readonly snapshotToken: RepositorySnapshotToken;
}

export interface CreateAnalysisRunOptions {
  readonly generation: AnalysisGeneration;
  readonly metrics: AnalysisMetricsRecorder;
  readonly signal: AbortSignal;
  readonly snapshotToken: RepositorySnapshotToken;
}

export function createAnalysisRun(
  options: CreateAnalysisRunOptions,
): AnalysisRun {
  return Object.freeze({
    generation: options.generation,
    id: identifier<'AnalysisRunId'>(randomUUID()),
    metrics: options.metrics,
    signal: options.signal,
    snapshotToken: options.snapshotToken,
  });
}

export function createNoopMetricsRecorder(): AnalysisMetricsRecorder {
  return Object.freeze({
    record(measurement: AnalysisMetricMeasurement): void {
      Object.hasOwn(measurement, 'name');
    },
  });
}
