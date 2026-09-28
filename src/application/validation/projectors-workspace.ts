import type { AnalysisGeneration } from '../../domain/shared/identifiers';
import { freezeArray } from '../../domain/validation/immutability';
import type {
  ImportFactsValidationView,
  ProjectValidationView,
  WorkspaceValidationView,
} from '../../domain/validation/views';
import type { AnalysisRun } from '../analysis/analysis-run';
import type {
  ImportFactsProvider,
  ProjectCatalogProvider,
  WorkspaceTopologyProvider,
} from '../analysis/providers';
import { recordProjection } from './projector-shared';
import type { ValidationReferencePoolProvider } from './reference-pool-provider';

export class WorkspaceValidationViewProvider {
  readonly #generations = new Map<
    AnalysisGeneration,
    Promise<WorkspaceValidationView>
  >();
  readonly #pool: ValidationReferencePoolProvider;
  readonly #topology: WorkspaceTopologyProvider;

  constructor(
    topology: WorkspaceTopologyProvider,
    pool: ValidationReferencePoolProvider,
  ) {
    this.#topology = topology;
    this.#pool = pool;
  }

  get(run: AnalysisRun): Promise<WorkspaceValidationView> {
    const cached = this.#generations.get(run.generation);

    if (cached) {
      return cached;
    }

    const startedAt = performance.now();
    const view = Promise.all([
      this.#topology.get(run),
      this.#pool.get(run),
    ]).then(([topology, pool]) => {
      const result: WorkspaceValidationView = Object.freeze({
        kind: 'workspace',
        packages: pool.packages,
        regions: freezeArray(
          topology.regions.map((region) =>
            Object.freeze({
              ...region,
              boundaryPaths: freezeArray(region.boundaryPaths),
              exclusionProvenance: freezeArray(region.exclusionProvenance),
              packageIds: freezeArray(region.packageIds),
            }),
          ),
        ),
      });
      recordProjection({
        count: result.regions.length,
        kind: result.kind,
        run,
        startedAt,
      });
      return result;
    });
    this.#generations.set(run.generation, view);
    return view;
  }

  releaseGeneration(generation: AnalysisGeneration): void {
    this.#generations.delete(generation);
  }
}

export class ProjectValidationViewProvider {
  readonly #catalog: ProjectCatalogProvider;
  readonly #generations = new Map<
    AnalysisGeneration,
    Promise<ProjectValidationView>
  >();
  readonly #pool: ValidationReferencePoolProvider;

  constructor(
    catalog: ProjectCatalogProvider,
    pool: ValidationReferencePoolProvider,
  ) {
    this.#catalog = catalog;
    this.#pool = pool;
  }

  get(run: AnalysisRun): Promise<ProjectValidationView> {
    const cached = this.#generations.get(run.generation);

    if (cached) {
      return cached;
    }

    const startedAt = performance.now();
    const view = Promise.all([
      this.#catalog.get(run),
      this.#pool.get(run),
    ]).then(([catalog, pool]) => {
      const result: ProjectValidationView = Object.freeze({
        ...pool,
        kind: 'projects',
        ownershipConflicts: freezeArray(
          catalog.ownershipConflicts.map((conflict) =>
            Object.freeze({
              ...conflict,
              candidateProjectIds: freezeArray(conflict.candidateProjectIds),
            }),
          ),
        ),
      });
      recordProjection({
        count: Object.keys(result.projects).length,
        kind: result.kind,
        run,
        startedAt,
      });
      return result;
    });
    this.#generations.set(run.generation, view);
    return view;
  }

  releaseGeneration(generation: AnalysisGeneration): void {
    this.#generations.delete(generation);
  }
}

export class ImportFactsValidationViewProvider {
  readonly #facts: ImportFactsProvider;
  readonly #generations = new Map<
    AnalysisGeneration,
    Promise<ImportFactsValidationView>
  >();
  readonly #pool: ValidationReferencePoolProvider;

  constructor(
    facts: ImportFactsProvider,
    pool: ValidationReferencePoolProvider,
  ) {
    this.#facts = facts;
    this.#pool = pool;
  }

  get(run: AnalysisRun): Promise<ImportFactsValidationView> {
    const cached = this.#generations.get(run.generation);

    if (cached) {
      return cached;
    }

    const startedAt = performance.now();
    const view = Promise.all([this.#facts.get(run), this.#pool.get(run)]).then(
      ([facts, pool]) => {
        const result: ImportFactsValidationView = Object.freeze({
          ...pool,
          kind: 'import-facts',
          occurrences: freezeArray(
            facts.occurrences.map((occurrence) =>
              Object.freeze({ ...occurrence }),
            ),
          ),
        });
        recordProjection({
          count: result.occurrences.length,
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
