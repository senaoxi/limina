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
  | 'provider-cache-hit'
  | 'provider-cache-miss'
  | 'projection'
  | 'source-parse'
  | 'source-read'
  | 'workspace-negative-lookup'
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
