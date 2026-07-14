import type { ResolvedLiminaConfig } from '#config/runner';
import { BuildGraphCore } from './build-graph';
import { ImportCore } from './imports';
import { PackageDomainCore } from './packages';
import { TsconfigCore } from './tsconfig';
import { WorkspaceCore } from './workspace';

export { BuildGraphCore } from './build-graph';
export { ImportCore } from './imports';
export type { ResolvedImportRecord, ResolveImportOptions } from './imports';
export { PackageDomainCore } from './packages';
export type { PackageDomain } from './packages';
export { TsconfigCore } from './tsconfig';
export type { SourceGraphProjects } from './tsconfig';
export { WorkspaceCore } from './workspace';

export class AnalysisProviderSet {
  readonly buildGraph: BuildGraphCore;
  readonly config: ResolvedLiminaConfig;
  readonly imports: ImportCore;
  readonly packages: PackageDomainCore;
  readonly tsconfig: TsconfigCore;
  readonly workspace: WorkspaceCore;

  constructor(config: ResolvedLiminaConfig) {
    let buildGraph: BuildGraphCore;

    this.config = config;
    this.workspace = new WorkspaceCore(config);
    this.imports = new ImportCore(config);
    this.tsconfig = new TsconfigCore(
      config,
      () => buildGraph.getGraph(),
      this.workspace,
    );
    buildGraph = new BuildGraphCore({
      config,
      imports: this.imports,
      workspace: this.workspace,
    });
    this.buildGraph = buildGraph;
    this.packages = new PackageDomainCore({
      buildGraph: this.buildGraph,
      tsconfig: this.tsconfig,
      workspace: this.workspace,
    });
  }
}

export function createAnalysisProviders(
  config: ResolvedLiminaConfig,
): AnalysisProviderSet {
  return new AnalysisProviderSet(config);
}
