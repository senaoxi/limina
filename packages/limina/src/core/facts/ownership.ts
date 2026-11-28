import type { CheckerProjectConfigCache } from '#checkers';
import type { ResolvedLiminaInputs } from '#config/runner';
import { withSourceConfigTextScope } from '#utils/source-config-text';
import {
  type AnalysisObserver,
  currentProfile,
} from '../../application/analysis/observability';
import { EpochInputs } from '../analysis-cache/epoch-inputs';
import { resolveGeneratedGraphCheckerSelections } from '../build-graph/checker-resolution';
import {
  beginCoreCollection,
  type FrameworkInferenceAmbiguity,
  readFrameworkInferenceAmbiguities,
} from '../build-graph/core-collection-run';
import type {
  CoreAnalysisPhaseObserver,
  ObservedCheckerSelection,
} from '../build-graph/types';
import type { ImportCore } from '../imports';
import type { ProjectDependencyCaches } from '../project-dependencies/contracts';
import { createWorkspaceSourceBoundaryFromProjects } from '../typescript-semantic';
import type { WorkspaceCore } from '../workspace';
import type { CoreFactSession } from './session';

/**
 * Provider-generation-scoped Stage B1 Ownership Finalization provider.
 * Owns Checker Ownership, Vue Promotion, Semantic Authority Freeze, and
 * WorkspaceSourceBoundary publication independently of Stage B2 (BuildGraphCore).
 */
export class CoreOwnershipProvider {
  readonly #config: ResolvedLiminaInputs;
  readonly #facts: CoreFactSession;
  readonly #imports: ImportCore;
  readonly #projectConfigs: CheckerProjectConfigCache;
  readonly #projectDependencies: ProjectDependencyCaches;
  readonly #workspace: WorkspaceCore;

  #ownershipPromise: Promise<ObservedCheckerSelection> | undefined;
  #svelteProjectsPromise: Promise<boolean> | undefined;
  #frameworkInferenceAmbiguities:
    | readonly FrameworkInferenceAmbiguity[]
    | undefined;
  readonly #profileWork = new WeakMap<AnalysisObserver, string>();

  constructor(options: {
    config: ResolvedLiminaInputs;
    facts: CoreFactSession;
    imports: ImportCore;
    projectConfigs: CheckerProjectConfigCache;
    projectDependencies: ProjectDependencyCaches;
    workspace: WorkspaceCore;
  }) {
    this.#config = options.config;
    this.#facts = options.facts;
    this.#imports = options.imports;
    this.#projectConfigs = options.projectConfigs;
    this.#projectDependencies = options.projectDependencies;
    this.#workspace = options.workspace;
  }

  getOwnershipProjection(options?: {
    onPhase?: CoreAnalysisPhaseObserver;
  }): Promise<ObservedCheckerSelection> {
    this.#ownershipPromise ??= withSourceConfigTextScope(async () => {
      const execute = async () => {
        const [workspaceContext, workspacePathIndex] = await Promise.all([
          this.#workspace.getValidatedContext(),
          this.#workspace.getPathIndex(),
        ]);
        beginCoreCollection(this.#projectDependencies);
        try {
          const inputs = new EpochInputs();
          const resolution = await inputs.collect(() =>
            resolveGeneratedGraphCheckerSelections({
              config: this.#config,
              workspaceContext,
              workspacePathIndex,
              importAnalysisContext: this.#imports.context,
              onPhase: options?.onPhase,
              projectConfigCache: this.#projectConfigs,
              projectDependencyCaches: this.#projectDependencies,
            }),
          );
          if (!this.#facts.hasWorkspaceSourceBoundary()) {
            this.#facts.publishWorkspaceSourceBoundary(
              createWorkspaceSourceBoundaryFromProjects(
                resolution.frozenProjectsByConfigPath
                  .values()
                  .map((frozen) => frozen.project)
                  .toArray(),
              ),
            );
          }
          return { ...resolution, inputs };
        } finally {
          this.retainInferenceDiagnostics(this.#projectDependencies);
        }
      };
      const profile = currentProfile();
      if (profile === undefined) return execute();
      const work = profile.start('core.analyze');
      this.#profileWork.set(profile, work);
      return profile.inWork(work, async () => {
        try {
          const resolution = await execute();
          profile.finish(work, 'computed');
          return resolution;
        } catch (error) {
          profile.fail(work, error, 'core-analysis-failed');
          throw error;
        }
      });
    });
    return this.#ownershipPromise;
  }

  getProfileWork(observer: AnalysisObserver): string | undefined {
    return this.#profileWork.get(observer);
  }

  hasSvelteCheckProjects(): Promise<boolean> {
    this.#svelteProjectsPromise ??= (async () => {
      const resolution = await this.getOwnershipProjection();
      return resolution.selections.some(
        ({ checker }) => checker.name === 'svelte-check',
      );
    })();
    return this.#svelteProjectsPromise;
  }

  retainInferenceDiagnostics(caches: ProjectDependencyCaches): void {
    const ambiguities = readFrameworkInferenceAmbiguities(caches);
    if (ambiguities !== undefined) {
      this.#frameworkInferenceAmbiguities = ambiguities;
    }
  }

  getFrameworkInferenceAmbiguities():
    | readonly FrameworkInferenceAmbiguity[]
    | undefined {
    return this.#frameworkInferenceAmbiguities;
  }
}
