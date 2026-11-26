import type {
  AnalysisMetricMeasurement,
  AnalysisMetricsRecorder,
} from '../application/analysis/analysis-run';
import {
  type AnalysisObserver,
  currentProfile,
} from '../application/analysis/observability';
import type { AtomicWriteOptions } from '../check-reporting/atomic-writer';
import type { LiminaPreflightManagerOptions } from './types';

export type SnapshotReadOperation =
  | 'read-bytes'
  | 'read-block'
  | 'check-baseline'
  | 'check-block';
type SnapshotWriteOperation = 'write-index' | 'write-block';
const resolutionCounterNames = new Set([
  'module-resolution-request',
  'module-resolution-index-hit',
  'module-resolution-index-miss',
]);
const resolutionKinds = new Set(['typescript', 'oxc', 'internal-import']);

function recordCounter(
  observer: AnalysisObserver,
  key: string,
  options: Pick<
    AnalysisMetricMeasurement,
    'count' | 'durationMs' | 'estimatedBytes'
  >,
): void {
  const scope = observer.currentScope;
  observer.metric(`${key}.calls`, scope, 'calls', options.count ?? 1);
  if (options.durationMs !== undefined)
    observer.metric(
      `${key}.elapsed-sum`,
      scope,
      'us',
      Math.round(options.durationMs * 1000),
    );
  if (options.estimatedBytes !== undefined)
    observer.metric(
      `${key}.estimated-bytes`,
      scope,
      'bytes',
      options.estimatedBytes,
    );
}

export function recordSnapshotIo(
  observer: AnalysisObserver,
  operation: SnapshotReadOperation | SnapshotWriteOperation,
  durationMs: number,
  bytes: number | undefined,
): void {
  const key = `snapshot.${operation}`;
  const scope = observer.currentScope;
  const estimatedBytes =
    operation === 'read-bytes' || operation === 'read-block'
      ? bytes
      : undefined;
  recordCounter(observer, key, { durationMs, estimatedBytes });
  if (bytes !== undefined)
    observer.metric(`${key}.bytes`, scope, 'bytes', bytes);
}

export function snapshotWriteObserver(
  operation: SnapshotWriteOperation,
): AtomicWriteOptions['observePayloadWrite'] {
  const observer = currentProfile();
  return observer === undefined
    ? undefined
    : ({ bytes, durationMs }) =>
        recordSnapshotIo(observer, operation, durationMs, bytes);
}

export function recordSnapshotPublication(
  observer: AnalysisObserver,
  durationMs: number,
  estimatedBytes: number,
): void {
  recordCounter(observer, 'snapshot.write', { durationMs, estimatedBytes });
}

function counterKey(
  name: AnalysisMetricMeasurement['name'],
): string | undefined {
  switch (name) {
    case 'module-resolution-request':
    case 'module-resolution-index-hit':
    case 'module-resolution-index-miss':
    case 'typescript-resolution':
    case 'internal-import-resolution':
    case 'source-read':
    case 'source-parse':
    case 'oxc-resolution':
    case 'oxc-resolver-factory-create':
    case 'oxc-resolver-factory-hit':
    case 'artifact-safety-lstat': {
      return name;
    }
    case 'typescript-module-resolution-cache-hit': {
      return 'typescript-resolution.directory-cache-hit';
    }
    case 'typescript-module-resolution-cache-miss': {
      return 'typescript-resolution.directory-cache-miss';
    }
    default: {
      return undefined;
    }
  }
}

class ScopedMetrics implements AnalysisMetricsRecorder {
  readonly observer: AnalysisObserver;
  readonly previous?: AnalysisMetricsRecorder;

  constructor(observer: AnalysisObserver, previous?: AnalysisMetricsRecorder) {
    this.observer = observer;
    this.previous = previous;
  }

  record(measurement: AnalysisMetricMeasurement): void {
    this.previous?.record(measurement);
    const { name, kind, count } = measurement;
    const key = counterKey(name);
    if (key === undefined) return;
    recordCounter(this.observer, key, measurement);
    if (
      kind !== undefined &&
      resolutionCounterNames.has(name) &&
      resolutionKinds.has(kind)
    )
      this.observer.metric(
        `${key}.${kind}.calls`,
        this.observer.currentScope,
        'calls',
        count ?? 1,
      );
  }
}

export function injectedAnalysisMetrics(
  metrics: AnalysisMetricsRecorder | undefined,
): AnalysisMetricsRecorder | undefined {
  return metrics instanceof ScopedMetrics ? metrics.previous : metrics;
}

export function withAnalysisProfileMetrics(
  options: LiminaPreflightManagerOptions,
): LiminaPreflightManagerOptions {
  const observer = currentProfile();
  return observer === undefined ||
    (options.metrics instanceof ScopedMetrics &&
      options.metrics.observer === observer)
    ? options
    : { ...options, metrics: new ScopedMetrics(observer, options.metrics) };
}
