import type { CheckerProjectConfigCache } from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import type { CheckerOwnershipPlan } from './checker-ownership-types';
import { connectCrossCheckerReferences } from './explicit-checker-ownership';
import { prepareCheckerGraph } from './prepare-checkers';
import type {
  PreparedCheckerGraph,
  ResolvedCheckerEntrySelection,
} from './types';

function createExplicitOwnerIndex(
  ownershipPlan: CheckerOwnershipPlan,
): Map<string, ResolvedCheckerEntrySelection['checker']['name']> {
  return new Map([
    ...[...ownershipPlan.typeConfigs.values()].flatMap((state) =>
      state.finalOwner === undefined
        ? []
        : [[state.configPath, state.finalOwner] as const],
    ),
    ...[...ownershipPlan.solutions.values()].flatMap((state) =>
      state.finalOwner === undefined
        ? []
        : [[state.configPath, state.finalOwner] as const],
    ),
  ]);
}

export function prepareCheckerGraphs(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaConfig;
  ownershipPlan: CheckerOwnershipPlan;
  projectConfigCache?: CheckerProjectConfigCache;
  selections: ResolvedCheckerEntrySelection[];
}): PreparedCheckerGraph[] {
  const explicitOwnerByConfigPath = createExplicitOwnerIndex(
    options.ownershipPlan,
  );
  const inheritedOwnerByConfigPath = new Map(explicitOwnerByConfigPath);
  const graphs = options.selections.map((selection) =>
    prepareCheckerGraph({
      ...options,
      explicitOwnerByConfigPath,
      inheritedOwnerByConfigPath,
      selection,
    }),
  );
  connectCrossCheckerReferences({ config: options.config, graphs });
  return graphs;
}
