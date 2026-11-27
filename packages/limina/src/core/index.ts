import { CheckerProjectConfigCache } from '#checkers';
import type { ResolvedLiminaInputs } from '#config/runner';
import type { AnalysisMetricsRecorder } from '../application/analysis/analysis-run';
import {
  createLiminaArtifactNamespace,
  type LiminaArtifactNamespace,
} from '../domain/artifacts/namespace';
import type { NativeAnalysisCache } from './analysis-cache/native-cache';
import { AstroSemanticContextManager } from './astro-semantic/context';
import { BuildGraphCore } from './build-graph';
import { CoreOwnershipProvider } from './facts/ownership';
import { PackageArtifactProvider } from './facts/package-artifacts';
import { CoreFactSession } from './facts/session';
import type { SubscriptionPlan } from './facts/subscription';
import type { ImportAnalysisMetricsRecorder } from './import-analysis/runner';
import { ImportCore } from './imports';
import { PackageDomainCore } from './packages';
import {
  createProjectDependencyCaches,
  type ProjectDependencyCaches,
  releaseProjectDependencyMemos,
} from './project-dependencies/runner';
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
  WorkspaceCoreMetricsRecorder &
  AnalysisMetricsRecorder;

export { BuildGraphCore } from './build-graph';
export type {
  CheckerSelectionResolution,
  CoreAnalysisPhase,
  CoreAnalysisPhaseHandle,
  CoreAnalysisPhaseObserver,
} from './build-graph/types';
export { CoreOwnershipProvider } from './facts/ownership';
export { PackageArtifactProvider } from './facts/package-artifacts';
export type { CachedPackedTarball } from './facts/package-artifacts';
export {
  CoreFactSession,
  CoreSubscriptionViolationError,
  type SubscribedCoreFactView,
} from './facts/session';
export {
  BUILTIN_CAPABILITY_SUBSCRIPTIONS,
  BUILTIN_RULE_SUBSCRIPTIONS,
  CORE_FACT_PRODUCERS,
  planCapabilitySubscriptions,
  planRuleSubscriptions,
} from './facts/subscription';
export type {
  CapabilitySubscription,
  FactProducerDescriptor,
  FactProduct,
  FactStage,
  GovernanceCapabilityId,
  GovernanceRuleId,
  PackageArtifactProduct,
  RuleSubscription,
  SubscriptionPlan,
} from './facts/subscription';
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
  readonly analysisCache?: NativeAnalysisCache;
  readonly subscriptionPlan?: SubscriptionPlan;
  readonly workspace?: WorkspaceCoreDependencies;
}

interface AnalysisProviderSetOptions {
  readonly artifactNamespace: LiminaArtifactNamespace;
  readonly config: ResolvedLiminaInputs;
  readonly dependencies: AnalysisProviderSetDependencies;
  readonly metrics?: AnalysisCoreMetricsRecorder;
}

export class AnalysisProviderSet {
  readonly artifactNamespace: LiminaArtifactNamespace;
  readonly astroSemanticContexts: AstroSemanticContextManager;
  readonly buildGraph: BuildGraphCore;
  readonly config: ResolvedLiminaInputs;
  readonly facts: CoreFactSession;
  readonly imports: ImportCore;
  readonly ownership: CoreOwnershipProvider;
  readonly packageArtifacts: PackageArtifactProvider;
  readonly packages: PackageDomainCore;
  readonly projectConfigs: CheckerProjectConfigCache;
  readonly projectDependencies: ProjectDependencyCaches;
  readonly svelteSemanticContexts: SvelteSemanticContextManager;
  readonly tsconfig: TsconfigCore;
  readonly typeEvidence: TypeEvidenceCore;
  readonly workspace: WorkspaceCore;
  readonly vueSemanticContexts: VueSemanticContextManager;

  constructor(options: AnalysisProviderSetOptions) {
    this.artifactNamespace = options.artifactNamespace;
    this.config = options.config;
    this.projectConfigs = new CheckerProjectConfigCache(
      options.artifactNamespace.generation,
      (config, virtualFiles) =>
        options.dependencies.analysisCache?.inputs.observeConfig(
          config.configClosure,
          virtualFiles,
        ),
    );
    this.projectDependencies = createProjectDependencyCaches(
      options.dependencies.analysisCache,
      options.metrics,
      options.dependencies.subscriptionPlan,
    );
    this.facts = new CoreFactSession(
      this.projectDependencies,
      options.dependencies.subscriptionPlan,
    );
    this.packageArtifacts = new PackageArtifactProvider();
    this.workspace = new WorkspaceCore(options.config, options.metrics, {
      ...options.dependencies.workspace,
      runWithInputs: (operation) => {
        const cache = options.dependencies.analysisCache;
        return cache === undefined
          ? operation()
          : cache.configReads.run(() => cache.epoch.run(operation));
      },
    });
    this.vueSemanticContexts = new VueSemanticContextManager(
      options.metrics,
      options.dependencies.analysisCache,
    );
    this.astroSemanticContexts = new AstroSemanticContextManager({
      governanceRoot: options.config.governanceRoot,
      metrics: options.metrics,
    });
    this.svelteSemanticContexts = new SvelteSemanticContextManager();
    this.imports = new ImportCore(options.config, {
      astroSemanticContexts: this.astroSemanticContexts,
      metrics: options.metrics,
      svelteSemanticContexts: this.svelteSemanticContexts,
      vueSemanticContexts: this.vueSemanticContexts,
      workspaceSourceBoundaryProvider: this.facts.getWorkspaceSourceBoundary,
    });
    this.typeEvidence = new TypeEvidenceCore({
      analysisCache: options.dependencies.analysisCache,
      generation: options.artifactNamespace.generation,
      importAnalysis: this.imports.context,
      metrics: options.metrics,
      vueSemanticContexts: this.vueSemanticContexts,
      workspaceSourceBoundaryProvider: this.facts.getWorkspaceSourceBoundary,
    });
    this.ownership = new CoreOwnershipProvider({
      config: options.config,
      facts: this.facts,
      imports: this.imports,
      projectConfigs: this.projectConfigs,
      projectDependencies: this.projectDependencies,
      workspace: this.workspace,
    });
    this.buildGraph = new BuildGraphCore({
      artifactNamespace: options.artifactNamespace,
      config: options.config,
      facts: this.facts,
      imports: this.imports,
      ownership: this.ownership,
      projectDependencies: this.projectDependencies,
      projectConfigs: this.projectConfigs,
      workspace: this.workspace,
    });
    this.tsconfig = new TsconfigCore({
      config: options.config,
      generatedGraphProvider: () => this.buildGraph.getGraph(),
      projectConfigCache: this.projectConfigs,
      workspace: this.workspace,
    });
    this.packages = new PackageDomainCore({
      buildGraph: this.buildGraph,
      workspace: this.workspace,
    });
  }

  releaseDependencyMemos(): void {
    this.facts.dispose();
    releaseProjectDependencyMemos(this.projectDependencies);
    this.imports.releaseDependencyMemos();
  }

  dispose(): void {
    this.facts.dispose();
    this.packageArtifacts.dispose();
    this.typeEvidence.dispose();
    this.astroSemanticContexts.dispose();
    this.svelteSemanticContexts.dispose();
    this.vueSemanticContexts.dispose();
  }
}

export function createAnalysisProviders(
  ...arguments_: [
    config: ResolvedLiminaInputs,
    artifactNamespace?: LiminaArtifactNamespace,
    metrics?: AnalysisCoreMetricsRecorder,
    dependencies?: AnalysisProviderSetDependencies,
  ]
): AnalysisProviderSet {
  const [config, configuredNamespace, metrics, dependencies = {}] = arguments_;
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
