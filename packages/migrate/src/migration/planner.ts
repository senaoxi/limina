import type {
  LiminaArtifactNamespace,
  ResolvedLiminaConfig,
} from 'limina/internal/migration';
import {
  type InputTopologyResult,
  readInputTopology,
} from 'limina/internal/migration';
import path from 'pathe';
import { MigrationInputError, type MigrationRecord } from './declarations';
import { discover } from './discovery';
import { inventory } from './inventory';
import { rewriteMembership } from './membership';
import { adoptOptionalOutputs } from './output-adoption';
import { freezePatches } from './patch-plan';
import {
  createPlanningState,
  type MigrationPlanningState,
  planningView,
} from './planning-state';
import { translateRelations } from './relation-plan';
import type { MigrationWritePlanItem } from './transaction';
export interface FrozenMigrationPlan {
  inputs: ReadonlyMap<string, string>;
  groups: MigrationWritePlanItem[][];
  records: MigrationRecord[];
  topology: InputTopologyResult;
  incomplete: boolean;
  targetCount: number;
}

function existingExclusions(state: MigrationPlanningState) {
  return state.config.regions?.exclude ?? [];
}

function planExclusions(state: MigrationPlanningState): void {
  const exclusions = [...state.isolated].map(([file, reason]) => ({
    kind: 'tsconfig' as const,
    include: [path.relative(state.config.rootDir, file)],
    reason: `Migration isolated an unreadable config: ${reason}`,
  }));
  for (const [file, message] of state.isolated)
    state.records.push({ configPath: file, kind: 'isolated', message });
  if (exclusions.length === 0) return;
  state.candidateConfig = {
    ...state.config,
    regions: {
      ...state.config.regions,
      exclude: [...existingExclusions(state), ...exclusions],
    },
  };
}

function planMembership(state: MigrationPlanningState): Set<string> {
  try {
    return rewriteMembership({
      rootDir: state.config.rootDir,
      targets: state.targets,
      objects: state.objects,
      records: state.records,
    });
  } catch (error) {
    if (!(error instanceof MigrationInputError)) throw error;
    state.incomplete = true;
    state.records.push({
      configPath: state.config.configPath,
      kind: 'membership-incomplete',
      message: error.message,
    });
    return new Set();
  }
}

export async function createFrozenMigrationPlan(
  config: ResolvedLiminaConfig,
  artifactNamespace: LiminaArtifactNamespace,
): Promise<FrozenMigrationPlan> {
  const state = createPlanningState(config, await discover(config));
  await inventory(state);
  planExclusions(state);
  const membershipChanges = planMembership(state);
  await adoptOptionalOutputs(state);
  await translateRelations(state, artifactNamespace);
  const topology = await readInputTopology(planningView(state));
  const groups = await freezePatches(state, topology, membershipChanges);
  return {
    inputs: state.snapshot,
    groups,
    records: state.records,
    topology,
    incomplete: state.incomplete || !topology.complete,
    targetCount: state.paths.length,
  };
}
