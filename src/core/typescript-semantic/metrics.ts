import type ts from 'typescript';
import type { AnalysisMetricsRecorder } from '../../application/analysis/analysis-run';

export function measureBoundedProgram(
  create: () => ts.Program,
  metrics: AnalysisMetricsRecorder | undefined,
): ts.Program {
  if (metrics === undefined) return create();
  const start = performance.now();
  try {
    return create();
  } finally {
    metrics.record({
      name: 'bounded-program-create',
      durationMs: performance.now() - start,
    });
  }
}

export class TypeCheckerObservation {
  #observed = false;
  readonly #metrics: AnalysisMetricsRecorder | undefined;
  constructor(metrics?: AnalysisMetricsRecorder) {
    this.#metrics = metrics;
  }
  get(program: ts.Program): ts.TypeChecker {
    if (this.#observed) return program.getTypeChecker();
    this.#observed = true;
    return this.#first(program);
  }
  #first(program: ts.Program): ts.TypeChecker {
    const start = performance.now();
    try {
      return program.getTypeChecker();
    } finally {
      this.#metrics?.record({
        name: 'bounded-first-typechecker',
        durationMs: performance.now() - start,
      });
    }
  }
}
