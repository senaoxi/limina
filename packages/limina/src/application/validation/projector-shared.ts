import type { AnalysisRun } from '../analysis/analysis-run';

export function recordProjection(options: {
  count: number;
  kind: string;
  run: AnalysisRun;
  startedAt: number;
}): void {
  options.run.metrics.record({
    count: options.count,
    durationMs: performance.now() - options.startedAt,
    estimatedBytes: options.count * 96,
    kind: options.kind,
    name: 'projection',
  });
}

function isUndefined(value: string | undefined): boolean {
  return value === undefined;
}

function classifyDefinedBoundary(
  left: string,
  right: string,
): 'cross' | 'same' {
  return left === right ? 'same' : 'cross';
}

export function classifyBoundary(
  left: string | undefined,
  right: string | undefined,
): 'cross' | 'same' | 'unclassified' {
  if ([left, right].some(isUndefined)) {
    return 'unclassified';
  }

  return classifyDefinedBoundary(left as string, right as string);
}
