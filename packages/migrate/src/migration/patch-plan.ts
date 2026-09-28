import type { InputTopologyResult } from 'limina/internal/migration';
import { createCommitGroups } from './commit-groups';
import { addStaticConfigExclusions } from './config-edit';
import { expectedInputFailure } from './discovery';
import { MigrationJsoncInputError } from './jsonc-validation';
import type { MigrationPlanningState } from './planning-state';
import type { MigrationWritePlanItem } from './transaction';
import { createMigrationWritePlanItem } from './transform';

function originalExclusions(state: MigrationPlanningState) {
  return state.config.regions?.exclude ?? [];
}

function plannedExclusions(state: MigrationPlanningState) {
  const existingCount = originalExclusions(state).length;
  return allExclusions(state).slice(existingCount);
}
function allExclusions(state: MigrationPlanningState) {
  return state.candidateConfig.regions?.exclude ?? [];
}

function sourcePatch(
  state: MigrationPlanningState,
  file: string,
): MigrationWritePlanItem | undefined {
  if (state.blockedTargets.has(file)) return undefined;
  return readSourcePatch(state, file);
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
async function exclusionPatch(
  state: MigrationPlanningState,
): Promise<MigrationWritePlanItem | undefined> {
  const exclusions = plannedExclusions(state);
  if (exclusions.length === 0) return undefined;
  try {
    const originalContent = state.snapshot.get(state.config.configPath)!;
    const originalBytes = Buffer.from(originalContent);
    const nextContent = addStaticConfigExclusions(
      state.config.configPath,
      originalContent,
      exclusions,
    );
    state.snapshot.set(state.config.configPath, originalContent);
    state.records.push({
      configPath: state.config.configPath,
      kind: 'exclusions-planned',
      message: 'Exact config exclusions; package activation is unchanged.',
      details: exclusions,
    });
    return {
      configPath: state.config.configPath,
      originalBytes,
      originalContent,
      nextContent,
      status: 'modified',
    };
  } catch (error) {
    return failedExclusionPatch(state, error);
  }
}
function failedExclusionPatch(
  state: MigrationPlanningState,
  error: unknown,
): undefined {
  if (!expectedInputFailure(error)) throw error;
  state.incomplete = true;
  state.records.push({
    configPath: state.config.configPath,
    kind: 'exclusions-not-persisted',
    message: error.message,
    details: plannedExclusions(state),
  });
  return undefined;
}
export async function freezePatches(
  state: MigrationPlanningState,
  topology: InputTopologyResult,
  membershipChanges: ReadonlySet<string>,
): Promise<MigrationWritePlanItem[][]> {
  const files = [...new Set([...topology.sources, ...topology.solutions])];
  const patches = files
    .map((file) => sourcePatch(state, file))
    .filter((item) => item !== undefined);
  const configPatch = await exclusionPatch(state);
  if (configPatch) patches.push(configPatch);
  return createCommitGroups(state, patches, membershipChanges);
}
