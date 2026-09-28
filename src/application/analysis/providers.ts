import type {
  DeclarationBuildGraph,
  ImportFacts,
  OutputBuildGraph,
  PackageArtifactGraph,
  PackageOutput,
  ProjectCatalog,
  ReleaseAssessment,
  SourceDependencyGraph,
  WorkspaceTopology,
} from '../../domain/analysis/aggregates';
import type { AnalysisGeneration } from '../../domain/shared/identifiers';
import type { AnalysisRun } from './analysis-run';

export type AggregateLoader<Value> = (run: AnalysisRun) => Promise<Value>;

function recordCache(run: AnalysisRun, provider: string, hit: boolean): void {
  run.metrics.record({
    name: hit ? 'provider-cache-hit' : 'provider-cache-miss',
    provider,
  });
}

export class WorkspaceTopologyProvider {
  readonly #generations = new Map<
    AnalysisGeneration,
    Promise<WorkspaceTopology>
  >();
  readonly #load: AggregateLoader<WorkspaceTopology>;

  constructor(load: AggregateLoader<WorkspaceTopology>) {
    this.#load = load;
  }

  get(run: AnalysisRun): Promise<WorkspaceTopology> {
    const cached = this.#generations.get(run.generation);
    recordCache(run, 'workspace-topology', Boolean(cached));
    if (cached) return cached;
    const value = this.#load(run);
    this.#generations.set(run.generation, value);
    return value;
  }

  releaseGeneration(generation: AnalysisGeneration): void {
    this.#generations.delete(generation);
  }
}

export class ProjectCatalogProvider {
  readonly #generations = new Map<
    AnalysisGeneration,
    Promise<ProjectCatalog>
  >();
  readonly #load: AggregateLoader<ProjectCatalog>;

  constructor(load: AggregateLoader<ProjectCatalog>) {
    this.#load = load;
  }

  get(run: AnalysisRun): Promise<ProjectCatalog> {
    const cached = this.#generations.get(run.generation);
    recordCache(run, 'project-catalog', Boolean(cached));
    if (cached) return cached;
    const value = this.#load(run);
    this.#generations.set(run.generation, value);
    return value;
  }

  releaseGeneration(generation: AnalysisGeneration): void {
    this.#generations.delete(generation);
  }
}

export class ImportFactsProvider {
  readonly #generations = new Map<AnalysisGeneration, Promise<ImportFacts>>();
  readonly #load: AggregateLoader<ImportFacts>;

  constructor(load: AggregateLoader<ImportFacts>) {
    this.#load = load;
  }

  get(run: AnalysisRun): Promise<ImportFacts> {
    const cached = this.#generations.get(run.generation);
    recordCache(run, 'import-facts', Boolean(cached));
    if (cached) return cached;
    const value = this.#load(run);
    this.#generations.set(run.generation, value);
    return value;
  }

  releaseGeneration(generation: AnalysisGeneration): void {
    this.#generations.delete(generation);
  }
}

export class SourceDependencyGraphProvider {
  readonly #generations = new Map<
    AnalysisGeneration,
    Promise<SourceDependencyGraph>
  >();
  readonly #load: AggregateLoader<SourceDependencyGraph>;

  constructor(load: AggregateLoader<SourceDependencyGraph>) {
    this.#load = load;
  }

  get(run: AnalysisRun): Promise<SourceDependencyGraph> {
    const cached = this.#generations.get(run.generation);
    recordCache(run, 'source-dependency-graph', Boolean(cached));
    if (cached) return cached;
    const value = this.#load(run);
    this.#generations.set(run.generation, value);
    return value;
  }

  releaseGeneration(generation: AnalysisGeneration): void {
    this.#generations.delete(generation);
  }
}

export class DeclarationBuildGraphProvider {
  readonly #generations = new Map<
    AnalysisGeneration,
    Promise<DeclarationBuildGraph>
  >();
  readonly #load: AggregateLoader<DeclarationBuildGraph>;

  constructor(load: AggregateLoader<DeclarationBuildGraph>) {
    this.#load = load;
  }

  get(run: AnalysisRun): Promise<DeclarationBuildGraph> {
    const cached = this.#generations.get(run.generation);
    recordCache(run, 'declaration-build-graph', Boolean(cached));
    if (cached) return cached;
    const value = this.#load(run);
    this.#generations.set(run.generation, value);
    return value;
  }

  releaseGeneration(generation: AnalysisGeneration): void {
    this.#generations.delete(generation);
  }
}

export class OutputBuildGraphProvider {
  readonly #generations = new Map<
    AnalysisGeneration,
    Promise<OutputBuildGraph>
  >();
  readonly #load: AggregateLoader<OutputBuildGraph>;

  constructor(load: AggregateLoader<OutputBuildGraph>) {
    this.#load = load;
  }

  get(run: AnalysisRun): Promise<OutputBuildGraph> {
    const cached = this.#generations.get(run.generation);
    recordCache(run, 'output-build-graph', Boolean(cached));
    if (cached) return cached;
    const value = this.#load(run);
    this.#generations.set(run.generation, value);
    return value;
  }

  releaseGeneration(generation: AnalysisGeneration): void {
    this.#generations.delete(generation);
  }
}

export class PackageArtifactGraphProvider {
  readonly #generations = new Map<
    AnalysisGeneration,
    Promise<PackageArtifactGraph>
  >();
  readonly #load: AggregateLoader<PackageArtifactGraph>;

  constructor(load: AggregateLoader<PackageArtifactGraph>) {
    this.#load = load;
  }

  get(run: AnalysisRun): Promise<PackageArtifactGraph> {
    const cached = this.#generations.get(run.generation);
    recordCache(run, 'package-artifact-graph', Boolean(cached));
    if (cached) return cached;
    const value = this.#load(run);
    this.#generations.set(run.generation, value);
    return value;
  }

  releaseGeneration(generation: AnalysisGeneration): void {
    this.#generations.delete(generation);
  }
}

export class PackageOutputProvider {
  readonly #generations = new Map<AnalysisGeneration, Promise<PackageOutput>>();
  readonly #load: AggregateLoader<PackageOutput>;

  constructor(load: AggregateLoader<PackageOutput>) {
    this.#load = load;
  }

  get(run: AnalysisRun): Promise<PackageOutput> {
    const cached = this.#generations.get(run.generation);
    recordCache(run, 'package-output', Boolean(cached));
    if (cached) return cached;
    const value = this.#load(run);
    this.#generations.set(run.generation, value);
    return value;
  }

  releaseGeneration(generation: AnalysisGeneration): void {
    this.#generations.delete(generation);
  }
}

export class ReleaseAssessmentProvider {
  readonly #generations = new Map<
    AnalysisGeneration,
    Promise<ReleaseAssessment>
  >();
  readonly #load: AggregateLoader<ReleaseAssessment>;

  constructor(load: AggregateLoader<ReleaseAssessment>) {
    this.#load = load;
  }

  get(run: AnalysisRun): Promise<ReleaseAssessment> {
    const cached = this.#generations.get(run.generation);
    recordCache(run, 'release-assessment', Boolean(cached));
    if (cached) return cached;
    const value = this.#load(run);
    this.#generations.set(run.generation, value);
    return value;
  }

  releaseGeneration(generation: AnalysisGeneration): void {
    this.#generations.delete(generation);
  }
}
