import type { AnalysisGeneration } from '../../domain/shared/identifiers';
import {
  freezeArray,
  freezeRecord,
} from '../../domain/validation/immutability';
import type {
  DeclarationBuildValidationView,
  ImportFactsValidationView,
  OutputBuildValidationView,
  PackageArtifactValidationView,
  PackageOutputValidationView,
  ProjectValidationView,
  ReleaseAssessmentValidationView,
  SourceDependencyValidationView,
  WorkspaceValidationView,
} from '../../domain/validation/views';
import type { AnalysisRun } from '../analysis/analysis-run';
import type {
  DeclarationBuildGraphProvider,
  ImportFactsProvider,
  OutputBuildGraphProvider,
  PackageArtifactGraphProvider,
  PackageOutputProvider,
  ProjectCatalogProvider,
  ReleaseAssessmentProvider,
  SourceDependencyGraphProvider,
  WorkspaceTopologyProvider,
} from '../analysis/providers';
import type { ValidationReferencePoolProvider } from './reference-pool-provider';

function recordProjection(
  run: AnalysisRun,
  kind: string,
  startedAt: number,
  count: number,
): void {
  run.metrics.record({
    count,
    durationMs: performance.now() - startedAt,
    estimatedBytes: count * 96,
    kind,
    name: 'projection',
  });
}

function classifyBoundary(
  left: string | undefined,
  right: string | undefined,
): 'cross' | 'same' | 'unclassified' {
  if (!left || !right) return 'unclassified';
  return left === right ? 'same' : 'cross';
}

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
    if (cached) return cached;
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
      recordProjection(run, result.kind, startedAt, result.regions.length);
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
    if (cached) return cached;
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
      recordProjection(
        run,
        result.kind,
        startedAt,
        Object.keys(result.projects).length,
      );
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
    if (cached) return cached;
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
        recordProjection(
          run,
          result.kind,
          startedAt,
          result.occurrences.length,
        );
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

export class SourceDependencyValidationViewProvider {
  readonly #generations = new Map<
    AnalysisGeneration,
    Promise<SourceDependencyValidationView>
  >();
  readonly #graph: SourceDependencyGraphProvider;
  readonly #pool: ValidationReferencePoolProvider;

  constructor(
    graph: SourceDependencyGraphProvider,
    pool: ValidationReferencePoolProvider,
  ) {
    this.#graph = graph;
    this.#pool = pool;
  }

  get(run: AnalysisRun): Promise<SourceDependencyValidationView> {
    const cached = this.#generations.get(run.generation);
    if (cached) return cached;
    const startedAt = performance.now();
    const view = Promise.all([this.#graph.get(run), this.#pool.get(run)]).then(
      ([graph, pool]) => {
        const result: SourceDependencyValidationView = Object.freeze({
          ...pool,
          edges: freezeArray(
            graph.edges.map((edge) => {
              const sourceProject = pool.projects[edge.fromProjectId];
              const targetProject =
                edge.target.kind === 'workspace-file' && edge.target.projectId
                  ? pool.projects[edge.target.projectId]
                  : undefined;

              return Object.freeze({
                ...edge,
                boundary: Object.freeze({
                  domain: classifyBoundary(
                    sourceProject?.domain,
                    targetProject?.domain,
                  ),
                  team: classifyBoundary(
                    sourceProject?.team,
                    targetProject?.team,
                  ),
                }),
                evidenceIds: freezeArray(edge.evidenceIds),
                target: Object.freeze({ ...edge.target }),
              });
            }),
          ),
          evidence: freezeRecord(
            graph.evidence.map((evidence) => [
              evidence.id,
              Object.freeze({ ...evidence }),
            ]),
          ),
          kind: 'source-dependencies',
          roots: freezeArray(graph.roots),
        });
        recordProjection(run, result.kind, startedAt, result.edges.length);
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
    if (cached) return cached;
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
        recordProjection(run, result.kind, startedAt, result.edges.length);
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
    if (cached) return cached;
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
        recordProjection(run, result.kind, startedAt, result.edges.length);
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
    if (cached) return cached;
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
        recordProjection(run, result.kind, startedAt, result.edges.length);
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

export class PackageOutputValidationViewProvider {
  readonly #generations = new Map<
    AnalysisGeneration,
    Promise<PackageOutputValidationView>
  >();
  readonly #output: PackageOutputProvider;
  readonly #pool: ValidationReferencePoolProvider;

  constructor(
    output: PackageOutputProvider,
    pool: ValidationReferencePoolProvider,
  ) {
    this.#output = output;
    this.#pool = pool;
  }

  get(run: AnalysisRun): Promise<PackageOutputValidationView> {
    const cached = this.#generations.get(run.generation);
    if (cached) return cached;
    const startedAt = performance.now();
    const view = Promise.all([this.#output.get(run), this.#pool.get(run)]).then(
      ([output, pool]) => {
        const result: PackageOutputValidationView = Object.freeze({
          ...pool,
          findings: freezeArray(
            output.findings.map((finding) =>
              Object.freeze({
                code: finding.code,
                evidence: freezeArray(
                  finding.evidenceIds.map((id) =>
                    Object.freeze({ id, kind: 'output', value: id }),
                  ),
                ),
                packageId: finding.packageId,
                tool: finding.tool,
              }),
            ),
          ),
          kind: 'package-output',
        });
        recordProjection(run, result.kind, startedAt, result.findings.length);
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

export class ReleaseAssessmentValidationViewProvider {
  readonly #assessment: ReleaseAssessmentProvider;
  readonly #generations = new Map<
    AnalysisGeneration,
    Promise<ReleaseAssessmentValidationView>
  >();
  readonly #pool: ValidationReferencePoolProvider;

  constructor(
    assessment: ReleaseAssessmentProvider,
    pool: ValidationReferencePoolProvider,
  ) {
    this.#assessment = assessment;
    this.#pool = pool;
  }

  get(run: AnalysisRun): Promise<ReleaseAssessmentValidationView> {
    const cached = this.#generations.get(run.generation);
    if (cached) return cached;
    const startedAt = performance.now();
    const view = Promise.all([
      this.#assessment.get(run),
      this.#pool.get(run),
    ]).then(([assessment, pool]) => {
      const result: ReleaseAssessmentValidationView = Object.freeze({
        ...pool,
        findings: freezeArray(
          assessment.findings.map((finding) => Object.freeze({ ...finding })),
        ),
        kind: 'release-assessment',
      });
      recordProjection(run, result.kind, startedAt, result.findings.length);
      return result;
    });
    this.#generations.set(run.generation, view);
    return view;
  }

  releaseGeneration(generation: AnalysisGeneration): void {
    this.#generations.delete(generation);
  }
}
