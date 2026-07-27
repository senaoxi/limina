import type { WorkspaceExportResolutionGroups } from './profiles';
import type { WorkspaceExportsMetricsRecorder } from './types';

const groupedTypeScriptExecutionMeasurement = {
  kind: 'request',
  name: 'workspace-export-grouped-typescript-execution',
  provider: 'workspace-exports',
} as const;
const groupedOxcExecutionMeasurement = {
  kind: 'request',
  name: 'workspace-export-grouped-oxc-execution',
  provider: 'workspace-exports',
} as const;
const originalResolutionRequestMeasurement = {
  kind: 'request',
  name: 'workspace-export-resolution-request',
  provider: 'workspace-exports',
} as const;
const originalTypeScriptResolutionMeasurement = {
  kind: 'request',
  name: 'workspace-export-typescript-resolution',
  provider: 'workspace-exports',
} as const;
const originalOxcResolutionMeasurement = {
  kind: 'request',
  name: 'workspace-export-oxc-resolution',
  provider: 'workspace-exports',
} as const;
const resultExpansionMeasurement = {
  kind: 'result',
  name: 'workspace-export-result-expansion',
  provider: 'workspace-exports',
} as const;

export const oxcResolverCacheEntryBatchSize = 128;

function recordProfileCount(options: {
  count: number;
  kind: string;
  metrics: WorkspaceExportsMetricsRecorder;
  name:
    | 'workspace-export-oxc-semantic-profile-count'
    | 'workspace-export-profile-count'
    | 'workspace-export-typescript-semantic-profile-count';
}): void {
  options.metrics.record({
    count: options.count,
    kind: options.kind,
    name: options.name,
    provider: 'workspace-exports',
  });
}

function getFallbackKind(
  profile: WorkspaceExportResolutionGroups['compiledOriginals'][number],
): string | undefined {
  if (profile.typescriptFallbackReason === null) return undefined;
  return profile.typescriptFallbackReason.kind;
}

function incrementFallbackCount(
  counts: Map<string, number>,
  kind: string,
): void {
  const current = counts.get(kind) ?? 0;
  counts.set(kind, current + 1);
}

function collectFallbackCounts(
  groups: WorkspaceExportResolutionGroups,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const profile of groups.compiledOriginals) {
    const kind = getFallbackKind(profile);
    if (kind !== undefined) incrementFallbackCount(counts, kind);
  }
  return counts;
}

function recordFallbackCounts(options: {
  groups: WorkspaceExportResolutionGroups;
  metrics: WorkspaceExportsMetricsRecorder;
}): void {
  for (const [kind, count] of collectFallbackCounts(options.groups)) {
    options.metrics.record({
      count,
      kind,
      name: 'workspace-export-typescript-profile-fallback',
      provider: 'workspace-exports',
    });
  }
}

export function recordWorkspaceExportProfileMetrics(options: {
  groups: WorkspaceExportResolutionGroups;
  metrics: WorkspaceExportsMetricsRecorder;
}): void {
  recordProfileCount({
    count: options.groups.originals.length,
    kind: 'input',
    metrics: options.metrics,
    name: 'workspace-export-profile-count',
  });
  recordProfileCount({
    count: options.groups.typescriptGroups.size,
    kind: 'semantic-v1',
    metrics: options.metrics,
    name: 'workspace-export-typescript-semantic-profile-count',
  });
  recordProfileCount({
    count: options.groups.oxcGroups.size,
    kind: 'factory-identity-v1',
    metrics: options.metrics,
    name: 'workspace-export-oxc-semantic-profile-count',
  });
  recordFallbackCounts(options);
}

export function recordGroupedTypeScriptExecution(
  metrics: WorkspaceExportsMetricsRecorder | undefined,
): void {
  metrics?.record(groupedTypeScriptExecutionMeasurement);
}

export function recordGroupedOxcExecution(
  metrics: WorkspaceExportsMetricsRecorder | undefined,
): void {
  metrics?.record(groupedOxcExecutionMeasurement);
}

export function recordOriginalResultExpansion(
  metrics: WorkspaceExportsMetricsRecorder | undefined,
): void {
  if (metrics === undefined) return;
  metrics.record(originalResolutionRequestMeasurement);
  metrics.record(originalTypeScriptResolutionMeasurement);
  metrics.record(originalOxcResolutionMeasurement);
  metrics.record(resultExpansionMeasurement);
}
