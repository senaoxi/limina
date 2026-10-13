import {
  configContextPath,
  type RegionsConfig,
} from 'limina/internal/config/runner';
import type { InputTopologyResult } from 'limina/internal/core/build-graph/input-topology';
import path from 'pathe';
import { createCommitGroups } from './commit-groups';
import { addStaticConfigExclusions } from './config-edit';
import { isExpectedInputFailure } from './discovery';
import { MigrationJsoncInputError } from './jsonc-validation';
import type { MigrationPlanningState } from './planning-state';
import type { MigrationWritePlanItem } from './transaction';
import { createMigrationWritePlanItem } from './transform';

function regionExclusions(regions: RegionsConfig | undefined) {
  return regions?.exclude ?? [];
}

function plannedExclusions(state: MigrationPlanningState) {
  const existing = regionExclusions(state.config.scope?.regions);
  const planned = regionExclusions(state.candidateConfig.scope?.regions);
  return planned.slice(existing.length);
}

function sourcePatch(
  state: MigrationPlanningState,
  file: string,
): MigrationWritePlanItem | undefined {
  return state.blockedTargets.has(file)
    ? undefined
    : readSourcePatch(state, file);
}
function readSourcePatch(
  state: MigrationPlanningState,
  file: string,
): MigrationWritePlanItem | undefined {
  try {
    return createMigrationWritePlanItem({
      config: state.config,
      target: state.targets.get(file)!,
      migratedConfig: state.objects.get(file)!,
    });
  } catch (error) {
    if (!(error instanceof MigrationJsoncInputError)) throw error;
    state.incomplete = true;
    state.records.push({
      configPath: file,
      kind: 'patch-unavailable',
      message: error.message,
    });
    return undefined;
  }
}
function recordExclusions(
  state: MigrationPlanningState,
  configPath: string,
  exclusions: ReturnType<typeof plannedExclusions>,
): void {
  state.records.push({
    configPath,
    kind: 'exclusions-planned',
    message:
      'Persist exact config exclusions; package activation is unchanged.',
    details: exclusions,
  });
}
function createIsolationConfig(
  state: MigrationPlanningState,
  exclusions: ReturnType<typeof plannedExclusions>,
): MigrationWritePlanItem {
  const configPath = path.join(state.config.rootDir, 'limina.config.mjs');
  recordExclusions(state, configPath, exclusions);
  return {
    operation: 'create',
    configPath,
    originalBytes: null,
    originalContent: null,
    nextContent: `export default ${JSON.stringify({ scope: { regions: { exclude: exclusions } } }, null, 2)};\n`,
    status: 'modified',
  };
}
function updateIsolationConfig(
  state: MigrationPlanningState,
  configPath: string,
  exclusions: ReturnType<typeof plannedExclusions>,
): MigrationWritePlanItem {
  const originalContent = state.snapshot.get(configPath)!;
  const nextContent = addStaticConfigExclusions(
    configPath,
    originalContent,
    exclusions,
  );
  recordExclusions(state, configPath, exclusions);
  return {
    configPath,
    originalBytes: Buffer.from(originalContent),
    originalContent,
    nextContent,
    status: 'modified',
  };
}
function isolationPatch(
  state: MigrationPlanningState,
  exclusions: ReturnType<typeof plannedExclusions>,
): MigrationWritePlanItem {
  return state.config.configPath === undefined
    ? createIsolationConfig(state, exclusions)
    : updateIsolationConfig(state, state.config.configPath, exclusions);
}
async function exclusionPatch(
  state: MigrationPlanningState,
): Promise<MigrationWritePlanItem | undefined> {
  const exclusions = plannedExclusions(state);
  if (exclusions.length === 0) return undefined;
  try {
    return isolationPatch(state, exclusions);
  } catch (error) {
    return failedExclusionPatch(state, error);
  }
}
function failedExclusionPatch(
  state: MigrationPlanningState,
  error: unknown,
): undefined {
  if (!isExpectedInputFailure(error)) throw error;
  state.incomplete = true;
  state.records.push({
    configPath: configContextPath(state.config),
    kind: 'exclusions-not-persisted',
    message: error.message,
    details: plannedExclusions(state),
  });
}
export async function freezePatches(
  state: MigrationPlanningState,
  topology: InputTopologyResult,
  membershipChanges: ReadonlySet<string>,
): Promise<MigrationWritePlanItem[][]> {
  const files = [
    ...new Set([
      ...topology.sources,
      ...topology.solutions,
      ...retainedCandidatePaths(state, topology, membershipChanges),
    ]),
  ];
  const patches = files
    .map((file) => sourcePatch(state, file))
    .filter((item) => item !== undefined);
  const configPatch = await exclusionPatch(state);
  if (configPatch) patches.push(configPatch);
  return createCommitGroups(state, patches, membershipChanges);
}

function retainedCandidatePaths(
  state: MigrationPlanningState,
  topology: InputTopologyResult,
  membershipChanges: ReadonlySet<string>,
): string[] {
  if (!topology.workspace) return [];
  return [
    ...membershipChanges,
    ...state.objects
      .keys()
      .filter((file) => !state.targets.get(file)!.isTypeScriptSolution),
  ];
}
