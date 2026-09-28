import type { AnalysisGeneration } from '../../domain/shared/identifiers';
import { freezeArray } from '../../domain/validation/immutability';
import type {
  DeclarationBuildValidationView,
  OutputBuildValidationView,
  PackageArtifactValidationView,
} from '../../domain/validation/views';
import type { AnalysisRun } from '../analysis/analysis-run';
import type {
  DeclarationBuildGraphProvider,
  OutputBuildGraphProvider,
  PackageArtifactGraphProvider,
} from '../analysis/providers';
import { recordProjection } from './projector-shared';
import type { ValidationReferencePoolProvider } from './reference-pool-provider';

export class DeclarationBuildValidationViewProvider {
  readonly #generations = new Map<
    AnalysisGeneration,
    Promise<DeclarationBuildValidationView>
  >();
  readonly #graph: DeclarationBuildGraphProvider;
  readonly #pool: ValidationReferencePoolProvider;

  constructor(
    graph: DeclarationBuildGraphProvider,
    pool: ValidationReferencePoolProvider,
  ) {
    this.#graph = graph;
    this.#pool = pool;
  }

  get(run: AnalysisRun): Promise<DeclarationBuildValidationView> {
    const cached = this.#generations.get(run.generation);

    if (cached) {
      return cached;
    }

    const startedAt = performance.now();
    const view = Promise.all([this.#graph.get(run), this.#pool.get(run)]).then(
      ([graph, pool]) => {
        const result: DeclarationBuildValidationView = Object.freeze({
          ...pool,
          edges: freezeArray(
            graph.edges.map((edge) => Object.freeze({ ...edge })),
          ),
          kind: 'declaration-build',
          stronglyConnectedComponents: freezeArray(
            graph.stronglyConnectedComponents.map(freezeArray),
          ),
        });
        recordProjection({
          count: result.edges.length,
          kind: result.kind,
          run,
          startedAt,
        });
        return result;
      },
    );
    this.#generations.set(run.generation, view);
    return view;
  }

  releaseGeneration(generation: AnalysisGeneration): void {
    this.#generations.delete(generation);
  }
}

export class OutputBuildValidationViewProvider {
  readonly #generations = new Map<
    AnalysisGeneration,
    Promise<OutputBuildValidationView>
  >();
  readonly #graph: OutputBuildGraphProvider;
  readonly #pool: ValidationReferencePoolProvider;

  constructor(
    graph: OutputBuildGraphProvider,
    pool: ValidationReferencePoolProvider,
  ) {
    this.#graph = graph;
    this.#pool = pool;
  }

  get(run: AnalysisRun): Promise<OutputBuildValidationView> {
    const cached = this.#generations.get(run.generation);

    if (cached) {
      return cached;
    }

    const startedAt = performance.now();
    const view = Promise.all([this.#graph.get(run), this.#pool.get(run)]).then(
      ([graph, pool]) => {
        const result: OutputBuildValidationView = Object.freeze({
          ...pool,
          edges: freezeArray(
            graph.edges.map((edge) => Object.freeze({ ...edge })),
          ),
          kind: 'output-build',
        });
        recordProjection({
          count: result.edges.length,
          kind: result.kind,
          run,
          startedAt,
        });
        return result;
      },
    );
    this.#generations.set(run.generation, view);
    return view;
  }

  releaseGeneration(generation: AnalysisGeneration): void {
    this.#generations.delete(generation);
  }
}

export class PackageArtifactValidationViewProvider {
  readonly #generations = new Map<
    AnalysisGeneration,
    Promise<PackageArtifactValidationView>
  >();
  readonly #graph: PackageArtifactGraphProvider;
  readonly #pool: ValidationReferencePoolProvider;

  constructor(
    graph: PackageArtifactGraphProvider,
    pool: ValidationReferencePoolProvider,
  ) {
    this.#graph = graph;
    this.#pool = pool;
  }

  get(run: AnalysisRun): Promise<PackageArtifactValidationView> {
    const cached = this.#generations.get(run.generation);

    if (cached) {
      return cached;
    }

    const startedAt = performance.now();
    const view = Promise.all([this.#graph.get(run), this.#pool.get(run)]).then(
      ([graph, pool]) => {
        const result: PackageArtifactValidationView = Object.freeze({
          ...pool,
          edges: freezeArray(
            graph.edges.map((edge) => Object.freeze({ ...edge })),
          ),
          kind: 'package-artifacts',
        });
        recordProjection({
          count: result.edges.length,
          kind: result.kind,
          run,
          startedAt,
        });
        return result;
      },
    );
    this.#generations.set(run.generation, view);
    return view;
  }

  releaseGeneration(generation: AnalysisGeneration): void {
    this.#generations.delete(generation);
  }
}
