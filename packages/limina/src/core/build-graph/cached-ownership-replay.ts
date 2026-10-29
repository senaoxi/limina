import type { ResolvedLiminaInputs } from '#config/runner';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import {
  type ValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../workspace/validated-context';
import type { CachedGraphData } from './analysis-cache-schema';
import { discoverCheckerOwnership } from './checker-ownership-discovery';
import { applyRootFileEvidence } from './checker-ownership-evidence';
import {
  finalizeLockedOwnership,
  runDependencyRequirements,
} from './checker-ownership-resolution';
import { freezeSemanticAuthorities } from './checker-semantic-authority';

/**
Recreate seeds from current inputs; cached final colors never confer authority.
*/
export async function hasCurrentOwnership(
  graph: CachedGraphData,
  config: ResolvedLiminaInputs,
  workspace: ValidatedWorkspaceContext,
): Promise<boolean> {
  const stored = graph.ownershipPlan;
  if (
    !stored.coloringInputs ||
    !stored.ownershipSelectionFacts ||
    !graph.sourceConfigCoverage
  )
    return false;
  const discovery = await discoverCheckerOwnership({
    config,
    activatedRegions: new WorkspaceRegionPathIndex(workspace),
    workspaceSourceConfigPaths: workspace.sourceConfigPaths,
    restoredSourceCoverage: graph.sourceConfigCoverage,
  });
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
  discovery.collectionProblems!.push(
    ...freezeSemanticAuthorities({
      config,
      states: discovery.plan.typeConfigs.values(),
    }),
  );
  if (discovery.collectionProblems!.length > 0) return false;
  const fingerprint = (states: Map<string, unknown>) =>
    nativeFingerprint(
      [...states].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  if (
    fingerprint(discovery.plan.typeConfigs) !==
    fingerprint(stored.coloringInputs.seeds)
  )
    return false;
  discovery.plan.dependencyFacts = stored.dependencyFacts;
  discovery.plan.dependencyFactPhase = 'locked';
  discovery.plan.declarationContexts = stored.declarationContexts;
  finalizeLockedOwnership({ config, discovery });
  return (
    fingerprint(discovery.plan.typeConfigs) ===
      fingerprint(stored.typeConfigs) &&
    fingerprint(discovery.plan.solutions) === fingerprint(stored.solutions) &&
    fingerprint(discovery.plan.sourceConfigPathsByEntry) ===
      fingerprint(stored.sourceConfigPathsByEntry)
  );
}
