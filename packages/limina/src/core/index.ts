import type { ResolvedLiminaConfig } from '#config/runner';
import {
  createLiminaArtifactNamespace,
  type LiminaArtifactNamespace,
} from '../domain/artifacts/namespace';
import { BuildGraphCore } from './build-graph';
import type { ImportAnalysisMetricsRecorder } from './import-analysis/runner';
import { ImportCore } from './imports';
import { PackageDomainCore } from './packages';
import { TsconfigCore } from './tsconfig';
import { TypeEvidenceCore } from './type-evidence';
import type { TypeEvidenceMetricsRecorder } from './type-evidence/cache';
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

export class AnalysisProviderSet {
  readonly artifactNamespace: LiminaArtifactNamespace;
  readonly buildGraph: BuildGraphCore;
  readonly config: ResolvedLiminaConfig;
  readonly imports: ImportCore;
  readonly packages: PackageDomainCore;
  readonly tsconfig: TsconfigCore;
  readonly typeEvidence: TypeEvidenceCore;
  readonly workspace: WorkspaceCore;

  constructor(
    config: ResolvedLiminaConfig,
    artifactNamespace: LiminaArtifactNamespace = createLiminaArtifactNamespace({
      generation: 0,
      rootDir: config.rootDir,
    }),
    metrics?: AnalysisCoreMetricsRecorder,
    dependencies: AnalysisProviderSetDependencies = {},
  ) {
    let buildGraph: BuildGraphCore;

    this.artifactNamespace = artifactNamespace;
    this.config = config;
    this.workspace = new WorkspaceCore(config, metrics, dependencies.workspace);
    this.imports = new ImportCore(config, metrics);
    this.tsconfig = new TsconfigCore(
      config,
      () => buildGraph.getGraph(),
      this.workspace,
    );
    this.typeEvidence = new TypeEvidenceCore({
      generation: artifactNamespace.generation,
      importAnalysis: this.imports.context,
      metrics,
    });
    buildGraph = new BuildGraphCore({
      artifactNamespace,
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

  dispose(): void {
    this.typeEvidence.dispose();
  }
}

export function createAnalysisProviders(
  config: ResolvedLiminaConfig,
  artifactNamespace?: LiminaArtifactNamespace,
  metrics?: AnalysisCoreMetricsRecorder,
  dependencies?: AnalysisProviderSetDependencies,
): AnalysisProviderSet {
  return new AnalysisProviderSet(
    config,
    artifactNamespace,
    metrics,
    dependencies,
  );
}
