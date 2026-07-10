import { clearCheckerProjectConfigCache } from '#checkers';
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

export class LiminaCore {
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

  invalidateAll(): void {
    this.workspace.invalidate();
    this.imports.invalidate();
    this.buildGraph.invalidate();
    this.tsconfig.invalidate();
    this.packages.invalidate();
    clearCheckerProjectConfigCache();
  }
}

export function createLiminaCore(config: ResolvedLiminaConfig): LiminaCore {
  return new LiminaCore(config);
}
