import { getCheckerAdapter } from '#checkers';
import type {
  ResolvedCheckerConfig,
  ResolvedLiminaConfig,
} from '#config/runner';
import { getActiveCheckers, isAutoCheckerConfigMode } from '#config/runner';
import type { LiminaFlowReporter } from '../flow';
import type { LiminaPreflightManager } from '../preflight';
import type { SourceIssueReportOptions } from '../source-check/report';
import type { RunPipelineOptions } from './types';

interface CheckerCapabilityBuckets {
  buildExecution: string[];
  noSourceGraph: string[];
  sourceGraph: string[];
  typecheckExecution: string[];
}

function createCapabilityBuckets(): CheckerCapabilityBuckets {
  return {
    buildExecution: [],
    noSourceGraph: [],
    sourceGraph: [],
    typecheckExecution: [],
  };
}

function appendExecutionCapability(options: {
  buckets: CheckerCapabilityBuckets;
  execution: string | undefined;
  label: string;
}): void {
  if (options.execution === 'build') {
    options.buckets.buildExecution.push(options.label);
  }
  if (options.execution === 'typecheck') {
    options.buckets.typecheckExecution.push(options.label);
  }
}

function appendSourceGraphCapability(options: {
  buckets: CheckerCapabilityBuckets;
  label: string;
  sourceGraph: boolean | undefined;
}): void {
  const target = options.sourceGraph
    ? options.buckets.sourceGraph
    : options.buckets.noSourceGraph;
  target.push(options.label);
}

function getAdapterCapabilities(preset: string): {
  execution: string | undefined;
  sourceGraph: boolean | undefined;
} {
  const adapter = getCheckerAdapter(preset);
  if (adapter === null) return { execution: undefined, sourceGraph: undefined };
  return { execution: adapter.execution, sourceGraph: adapter.sourceGraph };
}

function collectCheckerCapabilities(
  checkers: readonly ResolvedCheckerConfig[],
): CheckerCapabilityBuckets {
  const buckets = createCapabilityBuckets();
  for (const checker of checkers) {
    const capabilities = getAdapterCapabilities(checker.preset);
    const label = `${checker.name} (${checker.preset})`;
    appendExecutionCapability({
      buckets,
      execution: capabilities.execution,
      label,
    });
    appendSourceGraphCapability({
      buckets,
      label,
      sourceGraph: capabilities.sourceGraph,
    });
  }
  return buckets;
}

function formatCapabilityList(values: readonly string[]): string {
  return values.length === 0 ? '(none)' : values.join(', ');
}

function formatTypecheckNote(buckets: CheckerCapabilityBuckets): string[] {
  if (buckets.typecheckExecution.length === 0) return [];
  return [
    '  note: second-class checkers run through checker:typecheck; source graph participation is reported separately.',
  ];
}

function formatCapabilitySummary(buckets: CheckerCapabilityBuckets): string {
  return [
    'checker capability summary:',
    `  first-class build execution: ${formatCapabilityList(
      buckets.buildExecution,
    )}`,
    `  second-class typecheck execution: ${formatCapabilityList(
      buckets.typecheckExecution,
    )}`,
    `  source graph: ${formatCapabilityList(buckets.sourceGraph)}`,
    `  no source graph: ${formatCapabilityList(buckets.noSourceGraph)}`,
    ...formatTypecheckNote(buckets),
  ].join('\n');
}

export function reportCheckerCapabilities(
  config: ResolvedLiminaConfig,
  flow: LiminaFlowReporter | undefined,
  checkers: readonly ResolvedCheckerConfig[] = getActiveCheckers(config),
): void {
  if (flow === undefined) return;
  flow.info(formatCapabilitySummary(collectCheckerCapabilities(checkers)), {
    depth: 1,
  });
}

export function usesAutoCheckers(config: ResolvedLiminaConfig): boolean {
  const checkerConfig = config.config?.checkers;
  if (checkerConfig === undefined) return true;
  return isAutoCheckerConfigMode(checkerConfig);
}

export async function reportAutoCheckerCapabilities(
  config: ResolvedLiminaConfig,
  flow: LiminaFlowReporter | undefined,
  preflight: LiminaPreflightManager,
): Promise<void> {
  if (flow === undefined) return;
  try {
    const graph = await preflight.ensureGeneratedGraph();
    reportCheckerCapabilities(config, flow, graph.checkers);
  } catch {
    // Capability reporting is informational and must not replace task failures.
  }
}

function hasPackageNames(packageNames: readonly string[] | undefined): boolean {
  if (packageNames === undefined) return false;
  return packageNames.length > 0;
}

function hasPackageScope(options: RunPipelineOptions): boolean {
  if (options.sourceIssueReport !== undefined) return true;
  return hasPackageNames(options.packageNames);
}

function resolveReportPackageNames(
  options: RunPipelineOptions,
): readonly string[] | undefined {
  const reportPackageNames = options.sourceIssueReport?.packageNames;
  return reportPackageNames === undefined
    ? options.packageNames
    : reportPackageNames;
}

export function createSourceIssueReportOptions(
  options: RunPipelineOptions,
): SourceIssueReportOptions | undefined {
  if (!hasPackageScope(options)) return undefined;
  return {
    ...options.sourceIssueReport,
    packageNames: resolveReportPackageNames(options),
  };
}
