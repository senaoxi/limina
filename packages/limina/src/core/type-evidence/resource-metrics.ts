import type { TypeEvidenceMetricsRecorder } from './cache';

export type ResourceMetricName =
  | 'affected-source-config-count'
  | 'resource-import-count'
  | 'type-evidence-query';

export function recordMetric(
  metrics: TypeEvidenceMetricsRecorder | undefined,
  name: ResourceMetricName,
): void {
  if (metrics !== undefined) metrics.record({ name });
}

export function hasAffectedConfig(
  affectedConfigs: ReadonlySet<string> | undefined,
  configIdentity: string,
): boolean {
  return affectedConfigs !== undefined && affectedConfigs.has(configIdentity);
}

export function addAffectedConfig(
  affectedConfigs: Set<string> | undefined,
  configIdentity: string,
): void {
  if (affectedConfigs !== undefined) affectedConfigs.add(configIdentity);
}
