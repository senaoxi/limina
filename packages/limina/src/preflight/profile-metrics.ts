import type {
  AnalysisMetricMeasurement,
  AnalysisMetricsRecorder,
} from '../application/analysis/analysis-run';
import {
  type AnalysisObserver,
  currentProfile,
} from '../application/analysis/observability';
import type { LiminaPreflightManagerOptions } from './types';

class ScopedMetrics implements AnalysisMetricsRecorder {
  readonly observer: AnalysisObserver;
  readonly previous?: AnalysisMetricsRecorder;

  constructor(observer: AnalysisObserver, previous?: AnalysisMetricsRecorder) {
    this.observer = observer;
    this.previous = previous;
  }

  record(measurement: AnalysisMetricMeasurement): void {
    this.previous?.record(measurement);
    const { name, kind, count, durationMs, estimatedBytes } = measurement;
    let key: string;
    if (name === 'analysis-cache') {
      if (kind !== 'read-bytes' && kind !== 'read-block' && kind !== 'write')
        return;
      key = `snapshot.${kind}`;
    } else {
      switch (name) {
        case 'module-resolution-request':
        case 'module-resolution-index-hit':
        case 'module-resolution-index-miss':
        case 'typescript-resolution':
        case 'internal-import-resolution':
        case 'source-read':
        case 'source-parse':
        case 'syntax-cache':
        case 'oxc-resolution':
        case 'artifact-safety-lstat': {
          key = name;
          break;
        }
        default: {
          return;
        }
      }
    }
    const scope = this.observer.currentScope;
    this.observer.metric(`${key}.calls`, scope, 'calls', count ?? 1);
    if (durationMs !== undefined)
      this.observer.metric(
        `${key}.elapsed-sum`,
        scope,
        'us',
        Math.round(durationMs * 1000),
      );
    if (estimatedBytes !== undefined)
      this.observer.metric(
        `${key}.estimated-bytes`,
        scope,
        'bytes',
        estimatedBytes,
      );
  }
}

export function isObserverOnlyMetrics(
  metrics: AnalysisMetricsRecorder,
): boolean {
  return metrics instanceof ScopedMetrics && metrics.previous === undefined;
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
