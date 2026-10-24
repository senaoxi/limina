import type {
  RegionExcludeConfig,
  RegionsConfig,
  ResolvedLiminaInputs,
} from 'limina/internal/config/runner';
import { configContextPath } from 'limina/internal/config/runner';
import {
  type InputTopologyResult,
  readInputTopology,
} from 'limina/internal/core/build-graph/input-topology';
import type { LiminaArtifactNamespace } from 'limina/internal/domain/artifacts/namespace';
import { MigrationLogger } from 'limina/internal/logger';
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

export class MigrationPlanningError extends Error {
  readonly records: MigrationRecord[];
  constructor(cause: unknown, records: MigrationRecord[]) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.records = records;
  }
}

async function planningPhase<T>(
  state: MigrationPlanningState,
  phase: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const started = performance.now();
  let isComplete = false;
  MigrationLogger.info(`migration phase: ${phase}`);
  try {
    const result = await operation();
    isComplete = true;
    return result;
  } finally {
    const elapsedMilliseconds = Math.round(performance.now() - started);
    state.records.push({
      configPath: configContextPath(state.config),
      kind: 'planning-phase',
      message: `${phase}: ${isComplete ? 'complete' : 'failed'}`,
      details: { phase, complete: isComplete, elapsedMilliseconds },
    });
    MigrationLogger.info(
      `migration phase ${phase}: ${isComplete ? 'complete' : 'failed'} (${elapsedMilliseconds}ms)`,
    );
  }
}

export interface FrozenMigrationPlan {
  inputs: ReadonlyMap<string, string>;
  groups: MigrationWritePlanItem[][];
  records: MigrationRecord[];
  topology: InputTopologyResult;
  incomplete: boolean;
  targetCount: number;
}

function existingExclusions(regions: RegionsConfig | undefined) {
  return regions?.exclude ?? [];
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
  applyPlannedExclusions(state, exclusions);
}

function applyPlannedExclusions(
  state: MigrationPlanningState,
  exclusions: RegionExcludeConfig[],
): void {
  state.candidateConfig = {
    ...state.config,
    scope: {
      ...state.config.scope,
      regions: {
        ...state.config.scope?.regions,
        exclude: [
          ...existingExclusions(state.config.scope?.regions),
          ...exclusions,
        ],
      },
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
      configPath: configContextPath(state.config),
      kind: 'membership-incomplete',
      message: error.message,
    });
    return new Set();
  }
}

export async function createFrozenMigrationPlan(
  config: ResolvedLiminaInputs,
  artifactNamespace: LiminaArtifactNamespace,
): Promise<FrozenMigrationPlan> {
  const state = createPlanningState(config, []);
  try {
    state.paths = await planningPhase(state, 'discovery', () =>
      discover(config),
    );
    await planningPhase(state, 'inventory', () => inventory(state));
    planExclusions(state);
    const membershipChanges = await planningPhase(state, 'membership', () =>
      planMembership(state),
    );
    await planningPhase(state, 'outputs', () => adoptOptionalOutputs(state));
    await planningPhase(state, 'dependency-comparison', () =>
      translateRelations(state, artifactNamespace),
    );
    const topology = await planningPhase(state, 'input-topology', () =>
      readInputTopology(planningView(state)),
    );
    const groups = await planningPhase(state, 'patches', () =>
      freezePatches(state, topology, membershipChanges),
    );
    return {
      inputs: new Map([...state.snapshot, ...state.discoveryInputs]),
      groups,
      records: state.records,
      topology,
      incomplete: state.incomplete || !topology.complete,
      targetCount: state.paths.length,
    };
  } catch (error) {
    throw new MigrationPlanningError(error, state.records);
  }
}
