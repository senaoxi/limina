import type { CheckerProjectConfigCache } from '#checkers';
import type { ResolvedLiminaInputs } from '#config/runner';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import {
  type ValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../workspace/validated-context';
import type { CachedGraphData } from './analysis-cache-schema';
import {
  type CheckerOwnershipDiscovery,
  discoverCheckerOwnership,
} from './checker-ownership-discovery';
import { finalizeLockedOwnership } from './checker-ownership-resolution';
import type { FrameworkInferenceAmbiguity } from './core-collection-run';
import {
  freezeSemanticProject,
  type FrozenSemanticProject,
} from './locked-semantic-project';

/**
Bind precolor seeds to current config inputs before replaying final colors.
*/
export async function restoreOwnershipInputs(
  config: ResolvedLiminaInputs,
  workspace: ValidatedWorkspaceContext,
  cache: NativeAnalysisCache,
  projectConfigCache?: CheckerProjectConfigCache,
): Promise<CheckerOwnershipDiscovery | undefined> {
  const discovery = await discoverCheckerOwnership({
    config,
    cache,
    projectConfigCache,
    restoreOnly: true,
    activatedRegions: new WorkspaceRegionPathIndex(workspace),
    workspaceSourceConfigPaths: workspace.sourceConfigPaths,
  });
  return discovery.authoritiesComplete &&
    discovery.collectionInputFailure === undefined &&
    discovery.collectionProblems?.length === 0
    ? discovery
    : undefined;
}

export function replayCurrentOwnership(
  graph: CachedGraphData,
  config: ResolvedLiminaInputs,
  discovery: CheckerOwnershipDiscovery,
  projectConfigCache?: CheckerProjectConfigCache,
):
  | {
      ambiguities: readonly FrameworkInferenceAmbiguity[];
      frozenProjectsByConfigPath: ReadonlyMap<string, FrozenSemanticProject>;
    }
  | undefined {
  const stored = graph.ownershipPlan;
  if (!stored.coloringInputs || !graph.sourceConfigCoverage) return undefined;
  for (const enumeration of graph.sourceConfigCoverage.configurations) {
    if (
      enumeration.state === 'enumerated' &&
      enumeration.members.length > 0 &&
      !discovery.plan.typeConfigs.has(enumeration.configId) &&
      !discovery.plan.solutions.has(enumeration.configId)
    )
      return undefined;
  }
  const fingerprint = (states: Map<string, unknown>) =>
    nativeFingerprint(
      [...states].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  if (
    fingerprint(discovery.plan.typeConfigs) !==
    fingerprint(stored.coloringInputs.seeds)
  )
    return undefined;
  for (const project of discovery.projectByConfigPath.values()) {
    const authority = discovery.plan.typeConfigs.get(
      project.configPath,
    )?.frozenSemanticAuthority;
    if (authority === undefined) return undefined;
    discovery.frozenProjectsByConfigPath.set(
      project.configPath,
      freezeSemanticProject({
        project,
        authority,
        projectConfigCache,
        rootDir: config.rootDir,
      }),
    );
  }
  discovery.plan.dependencyFacts = stored.dependencyFacts;
  discovery.plan.dependencyFactPhase = 'locked';
  discovery.plan.declarationContexts = stored.declarationContexts;
  finalizeLockedOwnership({ config, discovery });
  const isCurrent =
    fingerprint(discovery.plan.typeConfigs) ===
      fingerprint(stored.typeConfigs) &&
    fingerprint(discovery.plan.solutions) === fingerprint(stored.solutions) &&
    fingerprint(discovery.plan.sourceConfigPathsByEntry) ===
      fingerprint(stored.sourceConfigPathsByEntry);
  return isCurrent
    ? {
        ambiguities: discovery.ambiguities ?? [],
        frozenProjectsByConfigPath: discovery.frozenProjectsByConfigPath,
      }
    : undefined;
}
