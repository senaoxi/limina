import type { ResolvedLiminaConfig } from '#config/runner';
import {
  type GeneratedProviderEdge,
  type GeneratedTsconfigGraphResult,
  prepareGeneratedTsconfigGraph,
} from '#core/build-graph/runner';
import type { LiminaArtifactNamespace } from '../domain/artifacts/namespace';
import type { ImportCore } from './imports';
import type { WorkspaceCore } from './workspace';

export class BuildGraphCore {
  readonly #config: ResolvedLiminaConfig;
  readonly #imports: ImportCore;
  readonly #workspace: WorkspaceCore;
  readonly #artifactNamespace: LiminaArtifactNamespace;
  #graphPromise: Promise<GeneratedTsconfigGraphResult> | undefined;

  constructor(options: {
    artifactNamespace: LiminaArtifactNamespace;
    config: ResolvedLiminaConfig;
    imports: ImportCore;
    workspace: WorkspaceCore;
  }) {
    this.#artifactNamespace = options.artifactNamespace;
    this.#config = options.config;
    this.#imports = options.imports;
    this.#workspace = options.workspace;
  }

  getGraph(): Promise<GeneratedTsconfigGraphResult> {
    this.#graphPromise ??= this.#prepareGraph();

    return this.#graphPromise;
  }

  #prepareGraph(): Promise<GeneratedTsconfigGraphResult> {
    return this.#workspace.getValidatedContext().then((topology) =>
      prepareGeneratedTsconfigGraph(this.#config, {
        artifactNamespace: this.#artifactNamespace,
        importAnalysisContext: this.#imports.context,
        workspaceContext: topology,
      }),
    );
  }

  async getSourceToDts(checkerName: string): Promise<Map<string, string>> {
    const graph = await this.getGraph();

    return new Map(graph.sourceToDts.get(checkerName));
  }

  async getProviderEdges(): Promise<GeneratedProviderEdge[]> {
    const graph = await this.getGraph();

    return graph.providerEdges.map((edge) => ({ ...edge }));
  }
}
