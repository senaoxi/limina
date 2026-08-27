import { CheckerProjectConfigCache } from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import {
  createLiminaArtifactNamespace,
  type LiminaArtifactNamespace,
} from '../domain/artifacts/namespace';
import { AstroSemanticContextManager } from './astro-semantic/context';
import { BuildGraphCore } from './build-graph';
import type { ImportAnalysisMetricsRecorder } from './import-analysis/runner';
import { ImportCore } from './imports';
import { PackageDomainCore } from './packages';
import { SvelteSemanticContextManager } from './svelte-semantic/context';
import { TsconfigCore } from './tsconfig';
import { TypeEvidenceCore } from './type-evidence';
import type { TypeEvidenceMetricsRecorder } from './type-evidence/cache';
import { VueSemanticContextManager } from './vue-semantic/context';
import {
  WorkspaceCore,
  type WorkspaceCoreDependencies,
  type WorkspaceCoreMetricsRecorder,
} from './workspace';

type AnalysisCoreMetricsRecorder = ImportAnalysisMetricsRecorder &
  TypeEvidenceMetricsRecorder &
  WorkspaceCoreMetricsRecorder;

export { BuildGraphCore } from './build-graph';
export { ImportCore } from './imports';
export type { ResolvedImportRecord, ResolveImportOptions } from './imports';
export { PackageDomainCore } from './packages';
export type { PackageDomain } from './packages';
export { TsconfigCore } from './tsconfig';
export type { SourceGraphProjects } from './tsconfig';
export { TypeEvidenceCore } from './type-evidence';
export type {
  AmbientSymbolLookupCache,
  ImportTypeEvidenceCache,
  ProgramCache,
  TypeEvidence,
  TypeEvidenceProgramHandle,
  TypeEvidenceProvider,
  TypeEvidenceProviderCache,
} from './type-evidence';
export { WorkspaceCore } from './workspace';

export interface AnalysisProviderSetDependencies {
  readonly workspace?: WorkspaceCoreDependencies;
}

interface AnalysisProviderSetOptions {
  readonly artifactNamespace: LiminaArtifactNamespace;
  readonly config: ResolvedLiminaConfig;
  readonly dependencies: AnalysisProviderSetDependencies;
  readonly metrics?: AnalysisCoreMetricsRecorder;
}

export class AnalysisProviderSet {
  readonly artifactNamespace: LiminaArtifactNamespace;
  readonly astroSemanticContexts: AstroSemanticContextManager;
  readonly buildGraph: BuildGraphCore;
  readonly config: ResolvedLiminaConfig;
  readonly imports: ImportCore;
  readonly packages: PackageDomainCore;
  readonly projectConfigs: CheckerProjectConfigCache;
  readonly svelteSemanticContexts: SvelteSemanticContextManager;
  readonly tsconfig: TsconfigCore;
  readonly typeEvidence: TypeEvidenceCore;
  readonly workspace: WorkspaceCore;
  readonly vueSemanticContexts: VueSemanticContextManager;

  constructor(options: AnalysisProviderSetOptions) {
    let buildGraph: BuildGraphCore;

    this.artifactNamespace = options.artifactNamespace;
    this.config = options.config;
    this.projectConfigs = new CheckerProjectConfigCache(
      options.artifactNamespace.generation,
    );
    this.workspace = new WorkspaceCore(
      options.config,
      options.metrics,
      options.dependencies.workspace,
    );
    this.vueSemanticContexts = new VueSemanticContextManager(options.metrics);
    this.astroSemanticContexts = new AstroSemanticContextManager({
      metrics: options.metrics,
    });
    this.svelteSemanticContexts = new SvelteSemanticContextManager();
    this.imports = new ImportCore(options.config, {
      astroSemanticContexts: this.astroSemanticContexts,
      metrics: options.metrics,
      svelteSemanticContexts: this.svelteSemanticContexts,
      vueSemanticContexts: this.vueSemanticContexts,
    });
    this.tsconfig = new TsconfigCore({
      config: options.config,
      generatedGraphProvider: () => buildGraph.getGraph(),
      projectConfigCache: this.projectConfigs,
      workspace: this.workspace,
    });
    this.typeEvidence = new TypeEvidenceCore({
      generation: options.artifactNamespace.generation,
      importAnalysis: this.imports.context,
      metrics: options.metrics,
      vueSemanticContexts: this.vueSemanticContexts,
    });
    buildGraph = new BuildGraphCore({
      artifactNamespace: options.artifactNamespace,
      config: options.config,
      imports: this.imports,
      projectConfigs: this.projectConfigs,
      workspace: this.workspace,
    });
    this.buildGraph = buildGraph;
    this.packages = new PackageDomainCore({
      buildGraph: this.buildGraph,
      workspace: this.workspace,
    });
  }

  dispose(): void {
    this.typeEvidence.dispose();
    this.astroSemanticContexts.dispose();
    this.svelteSemanticContexts.dispose();
    this.vueSemanticContexts.dispose();
  }
}

export function createAnalysisProviders(
  ...args: [
    config: ResolvedLiminaConfig,
    artifactNamespace?: LiminaArtifactNamespace,
    metrics?: AnalysisCoreMetricsRecorder,
    dependencies?: AnalysisProviderSetDependencies,
  ]
): AnalysisProviderSet {
  const [config, configuredNamespace, metrics, dependencies = {}] = args;
  const artifactNamespace =
    configuredNamespace ??
    createLiminaArtifactNamespace({
      generation: 0,
      rootDir: config.rootDir,
    });

  return new AnalysisProviderSet({
    artifactNamespace,
    config,
    dependencies,
    metrics,
  });
}
