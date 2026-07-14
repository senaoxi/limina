import type { ResolvedLiminaConfig } from '#config/runner';
import {
  type GeneratedProviderEdge,
  type GeneratedTsconfigGraphResult,
  prepareGeneratedTsconfigGraph,
} from '#core/build-graph/runner';
import type { ImportCore } from './imports';
import type { WorkspaceCore } from './workspace';

export class BuildGraphCore {
  readonly #config: ResolvedLiminaConfig;
  readonly #imports: ImportCore;
  readonly #workspace: WorkspaceCore;
  #graphPromise: Promise<GeneratedTsconfigGraphResult> | undefined;

  constructor(options: {
    config: ResolvedLiminaConfig;
    imports: ImportCore;
    workspace: WorkspaceCore;
  }) {
    this.#config = options.config;
    this.#imports = options.imports;
    this.#workspace = options.workspace;
  }

  getGraph(): Promise<GeneratedTsconfigGraphResult> {
    this.#graphPromise ??= this.#prepareGraph();

    return this.#graphPromise;
  }

  #prepareGraph(): Promise<GeneratedTsconfigGraphResult> {
    return this.#workspace.getRegionTopology().then((topology) =>
      prepareGeneratedTsconfigGraph(this.#config, {
        importAnalysisContext: this.#imports.context,
        workspacePackagesProvider: () => Promise.resolve(topology.packages),
        workspaceRegionBoundaries: topology.boundaries,
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
