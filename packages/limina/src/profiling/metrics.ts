import { compareCodeUnits } from '#utils/collections';
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

function addMetricValue(
  current: number | undefined,
  next: number | undefined,
  defaultIncrement: number,
): number {
  return (current ?? 0) + (next ?? defaultIncrement);
}

function readAggregateValue(
  current: AnalysisMetricAggregate | undefined,
  select: (aggregate: AnalysisMetricAggregate) => number,
): number | undefined {
  return current === undefined ? undefined : select(current);
}

function aggregateMeasurement(
  current: AnalysisMetricAggregate | undefined,
  measurement: AnalysisMetricMeasurement,
): AnalysisMetricAggregate {
  return {
    count: addMetricValue(
      readAggregateValue(current, (aggregate) => aggregate.count),
      measurement.count,
      1,
    ),
    durationMs: addMetricValue(
      readAggregateValue(current, (aggregate) => aggregate.durationMs),
      measurement.durationMs,
      0,
    ),
    estimatedBytes: addMetricValue(
      readAggregateValue(current, (aggregate) => aggregate.estimatedBytes),
      measurement.estimatedBytes,
      0,
    ),
    kind: measurement.kind,
    name: measurement.name,
    provider: measurement.provider,
    reports: addMetricValue(
      readAggregateValue(current, (aggregate) => aggregate.reports),
      measurement.reports,
      1,
    ),
  };
}

function copyAndSortMeasurements(
  measurements: ReadonlyMap<string, AnalysisMetricAggregate>,
): AnalysisMetricAggregate[] {
  return [...measurements.values()]
    .map((measurement) => ({ ...measurement }))
    .sort((left, right) => compareCodeUnits(metricKey(left), metricKey(right)));
}

export function createProfilingMetricsRecorder(): ProfilingMetricsRecorder {
  const measurements = new Map<string, AnalysisMetricAggregate>();

  return Object.freeze({
    record(measurement: AnalysisMetricMeasurement): void {
      const key = metricKey(measurement);
      measurements.set(
        key,
        aggregateMeasurement(measurements.get(key), measurement),
      );
    },
    snapshot(): AnalysisMetricAggregate[] {
      return copyAndSortMeasurements(measurements);
    },
  });
}
