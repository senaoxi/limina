import type { ResolvedLiminaConfig } from '#config/runner';
import {
  type GeneratedProviderEdge,
  type GeneratedTsconfigGraphResult,
  prepareGeneratedTsconfigGraph,
} from '#core/build-graph/runner';
import type { ImportCore } from './imports';
import type { WorkspaceCore } from './workspace';

export interface PrepareGraphOptions {
  write?: true;
}

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

  invalidate(): void {
    this.#graphPromise = undefined;
  }

  getGraph(): Promise<GeneratedTsconfigGraphResult> {
    this.#graphPromise ??= prepareGeneratedTsconfigGraph(this.#config, {
      importAnalysisContext: this.#imports.context,
      workspacePackagesProvider: () => this.#workspace.getPackages(),
    });

    return this.#graphPromise;
  }

  prepareGraph(
    options: PrepareGraphOptions = { write: true },
  ): Promise<GeneratedTsconfigGraphResult> {
    const shouldWrite = options.write ?? true;

    if (!shouldWrite) {
      return this.getGraph();
    }
    return this.getGraph();
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
