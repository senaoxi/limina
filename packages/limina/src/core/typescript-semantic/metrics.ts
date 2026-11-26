import type ts from 'typescript';
import type { AnalysisMetricsRecorder } from '../../application/analysis/analysis-run';
import {
  currentProfile,
  type ProfileScope,
} from '../../application/analysis/observability';
import { observeWork, priorProfileContextScope } from '../analysis-profile';

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
      count: 1,
      durationMs: performance.now() - start,
    });
  }
}

export class TypeCheckerObservation {
  #observed = false;

  readonly #metrics: AnalysisMetricsRecorder | undefined;
  readonly #instance: object;
  readonly #configPath: string;

  constructor(options: {
    metrics?: AnalysisMetricsRecorder;
    instance: object;
    configPath: string;
  }) {
    this.#metrics = options.metrics;
    this.#instance = options.instance;
    this.#configPath = options.configPath;
  }

  #first(program: ts.Program): ts.TypeChecker {
    const start = performance.now();
    const observer = currentProfile();
    const scope: ProfileScope | undefined =
      observer === undefined
        ? undefined
        : (priorProfileContextScope(observer, this.#instance) ?? [
            'project',
            observer.project(this.#configPath),
          ]);
    try {
      return observeWork(
        observer,
        'native-first-typechecker',
        () => program.getTypeChecker(),
        scope,
        undefined,
        'computed',
      );
    } finally {
      this.#metrics?.record({
        name: 'bounded-first-typechecker',
        count: 1,
        durationMs: performance.now() - start,
      });
    }
  }

  get(program: ts.Program): ts.TypeChecker {
    if (this.#observed) return program.getTypeChecker();
    this.#observed = true;
    return this.#first(program);
  }
}
