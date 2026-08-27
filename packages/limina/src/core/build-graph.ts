import type { CheckerProjectConfigCache } from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import {
  type GeneratedDependencyEdge,
  type GeneratedTsconfigGraphResult,
  prepareGeneratedTsconfigGraph,
} from '#core/build-graph/runner';
import type { LiminaArtifactNamespace } from '../domain/artifacts/namespace';
import type { ImportCore } from './imports';
import type { WorkspaceCore } from './workspace';

export class BuildGraphCore {
  readonly #config: ResolvedLiminaConfig;
  readonly #imports: ImportCore;
  readonly #projectConfigs: CheckerProjectConfigCache;
  readonly #workspace: WorkspaceCore;
  readonly #artifactNamespace: LiminaArtifactNamespace;
  #graphPromise: Promise<GeneratedTsconfigGraphResult> | undefined;

  constructor(options: {
    artifactNamespace: LiminaArtifactNamespace;
    config: ResolvedLiminaConfig;
    imports: ImportCore;
    projectConfigs: CheckerProjectConfigCache;
    workspace: WorkspaceCore;
  }) {
    this.#artifactNamespace = options.artifactNamespace;
    this.#config = options.config;
    this.#imports = options.imports;
    this.#projectConfigs = options.projectConfigs;
    this.#workspace = options.workspace;
  }

  getGraph(): Promise<GeneratedTsconfigGraphResult> {
    this.#graphPromise ??= this.#prepareGraph();

    return this.#graphPromise;
  }

  #prepareGraph(): Promise<GeneratedTsconfigGraphResult> {
    return Promise.all([
      this.#workspace.getValidatedContext(),
      this.#workspace.getPathIndex(),
    ]).then(([topology, workspacePathIndex]) =>
      prepareGeneratedTsconfigGraph(this.#config, {
        artifactNamespace: this.#artifactNamespace,
        importAnalysisContext: this.#imports.context,
        projectConfigCache: this.#projectConfigs,
        workspaceContext: topology,
        workspacePathIndex,
      }),
    );
  }

  async getSourceToDts(checkerName: string): Promise<Map<string, string>> {
    const graph = await this.getGraph();

    return new Map(graph.sourceToDts.get(checkerName));
  }

  async getDependencyEdges(): Promise<GeneratedDependencyEdge[]> {
    const graph = await this.getGraph();

    return graph.dependencyEdges.map((edge) => ({ ...edge }));
  }
}
