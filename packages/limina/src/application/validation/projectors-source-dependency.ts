import type { AnalysisGeneration } from '../../domain/shared/identifiers';
import {
  freezeArray,
  freezeRecord,
} from '../../domain/validation/immutability';
import type { SourceDependencyValidationView } from '../../domain/validation/views';
import type { AnalysisRun } from '../analysis/analysis-run';
import type { SourceDependencyGraphProvider } from '../analysis/providers';
import { classifyBoundary, recordProjection } from './projector-shared';
import type { ValidationReferencePoolProvider } from './reference-pool-provider';

type ReferencePool = Awaited<
  ReturnType<ValidationReferencePoolProvider['get']>
>;
type PoolProjects = ReferencePool['projects'];
type PoolProject = PoolProjects[keyof PoolProjects];
type ProjectId = keyof PoolProjects;
type SourceDependencyGraph = Awaited<
  ReturnType<SourceDependencyGraphProvider['get']>
>;
type SourceDependencyEdge = SourceDependencyGraph['edges'][number];

function getProject(
  projects: PoolProjects,
  projectId: ProjectId | undefined,
): PoolProject | undefined {
  return projectId === undefined ? undefined : projects[projectId];
}

function getProjectField(
  project: PoolProject | undefined,
  field: 'domain' | 'team',
): string | undefined {
  return project === undefined ? undefined : project[field];
}

function getTargetProjectId(edge: SourceDependencyEdge): ProjectId | undefined {
  return edge.target.kind === 'workspace-file'
    ? edge.target.projectId
    : undefined;
}

function projectSourceDependencyEdge(
  edge: SourceDependencyEdge,
  pool: ReferencePool,
) {
  const sourceProject = getProject(pool.projects, edge.fromProjectId);
  const targetProject = getProject(pool.projects, getTargetProjectId(edge));

  const boundary = Object.freeze({
    domain: classifyBoundary(
      getProjectField(sourceProject, 'domain'),
      getProjectField(targetProject, 'domain'),
    ),
    team: classifyBoundary(
      getProjectField(sourceProject, 'team'),
      getProjectField(targetProject, 'team'),
    ),
  });
  return Object.freeze({
    ...edge,
    boundary,
    evidenceIds: freezeArray(edge.evidenceIds),
    target: Object.freeze({ ...edge.target }),
  });
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

    if (cached) {
      return cached;
    }

    const startedAt = performance.now();
    const prerequisite = Promise.all([
      this.#graph.get(run),
      this.#pool.get(run),
    ]);
    const view = (async () => {
      const [graph, pool] = await prerequisite;

      const result: SourceDependencyValidationView = Object.freeze({
        ...pool,
        edges: freezeArray(
          graph.edges.map((edge) => projectSourceDependencyEdge(edge, pool)),
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
      recordProjection({
        count: result.edges.length,
        kind: result.kind,
        run,
        startedAt,
      });
      return result;
    })();
    this.#generations.set(run.generation, view);
    return view;
  }

  releaseGeneration(generation: AnalysisGeneration): void {
    this.#generations.delete(generation);
  }
}
