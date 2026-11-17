import type { ResolvedLiminaInputs } from '#config/runner';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import {
  type ValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../workspace/validated-context';
import type { CachedGraphData } from './analysis-cache-schema';
import { discoverCheckerOwnership } from './checker-ownership-discovery';
import {
  applyRootFileEvidence,
  commitFrameworkInference,
} from './checker-ownership-evidence';
import {
  finalizeLockedOwnership,
  runDependencyRequirements,
} from './checker-ownership-resolution';
import { freezeSemanticAuthorities } from './checker-semantic-authority';
import type { FrameworkInferenceAmbiguity } from './core-collection-run';

/**
Recreate seeds from current inputs; cached final colors never confer authority.
*/
export async function replayCurrentOwnership(
  graph: CachedGraphData,
  config: ResolvedLiminaInputs,
  workspace: ValidatedWorkspaceContext,
): Promise<
  { ambiguities: readonly FrameworkInferenceAmbiguity[] } | undefined
> {
  const stored = graph.ownershipPlan;
  if (
    !stored.coloringInputs ||
    !stored.ownershipSelectionFacts ||
    !graph.sourceConfigCoverage
  )
    return undefined;
  const discovery = await discoverCheckerOwnership({
    config,
    activatedRegions: new WorkspaceRegionPathIndex(workspace),
    workspaceSourceConfigPaths: workspace.sourceConfigPaths,
    restoredSourceCoverage: graph.sourceConfigCoverage,
  });
  if (discovery.collectionInputFailure !== undefined) return undefined;
  discovery.collectionProblems!.push(
    ...applyRootFileEvidence({
      config,
      plan: discovery.plan,
      projectByConfigPath: discovery.projectByConfigPath,
    }),
  );
  discovery.plan.dependencyFacts = [...stored.ownershipSelectionFacts];
  discovery.plan.dependencyFactPhase = 'selection';
  runDependencyRequirements({ config, discovery });
  const inference = commitFrameworkInference({ config, plan: discovery.plan });
  discovery.collectionProblems!.push(
    ...inference.problems,
    ...freezeSemanticAuthorities({
      config,
      states: discovery.plan.typeConfigs.values(),
    }),
  );
  if (discovery.collectionProblems!.length > 0) return undefined;
  const fingerprint = (states: Map<string, unknown>) =>
    nativeFingerprint(
      [...states].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  if (
    fingerprint(discovery.plan.typeConfigs) !==
    fingerprint(stored.coloringInputs.seeds)
  )
    return undefined;
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
  return isCurrent ? { ambiguities: inference.ambiguities } : undefined;
}
