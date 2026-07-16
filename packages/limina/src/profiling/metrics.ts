import type {
  AnalysisMetricMeasurement,
  AnalysisMetricsRecorder,
} from '../application/analysis/analysis-run';

export interface AnalysisMetricAggregate extends AnalysisMetricMeasurement {
  readonly count: number;
  readonly durationMs: number;
  readonly estimatedBytes: number;
  readonly reports: number;
}

export interface ProfilingMetricsRecorder extends AnalysisMetricsRecorder {
  snapshot(): AnalysisMetricAggregate[];
}

function metricKey(measurement: AnalysisMetricMeasurement): string {
  return JSON.stringify([
    measurement.name,
    measurement.provider ?? '',
    measurement.kind ?? '',
  ]);
}

export function createProfilingMetricsRecorder(): ProfilingMetricsRecorder {
  const measurements = new Map<string, AnalysisMetricAggregate>();

  return Object.freeze({
    record(measurement: AnalysisMetricMeasurement): void {
      const key = metricKey(measurement);
      const current = measurements.get(key);
      measurements.set(key, {
        count: (current?.count ?? 0) + (measurement.count ?? 1),
        durationMs: (current?.durationMs ?? 0) + (measurement.durationMs ?? 0),
        estimatedBytes:
          (current?.estimatedBytes ?? 0) + (measurement.estimatedBytes ?? 0),
        kind: measurement.kind,
        name: measurement.name,
        provider: measurement.provider,
        reports: (current?.reports ?? 0) + (measurement.reports ?? 1),
      });
    },
    snapshot(): AnalysisMetricAggregate[] {
      return [...measurements.values()]
        .map((measurement) => ({ ...measurement }))
        .sort((left, right) => metricKey(left).localeCompare(metricKey(right)));
    },
  });
}
