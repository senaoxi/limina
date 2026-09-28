import type { ResolvedLiminaConfig } from '#config/runner';
import { readFile } from 'node:fs/promises';
import path from 'pathe';
import { writeJsonAtomically } from '../../check-reporting/atomic-writer';
import { formatErrorMessage, MigrationLogger } from '../../logger';
import type { LiminaPreflightManager } from '../../preflight';
import {
  createExecutionState,
  executeGroups,
  type MigrationExecutionState,
  prepareGroups,
} from './execution-groups';
import { collectMigrationWorktreeRoots } from './git';
import {
  confirmDirtyWorkspaceChanges,
  decideHardlinkPolicy,
  type MigrationTask,
} from './interactions';
import { createFrozenMigrationPlan, type FrozenMigrationPlan } from './planner';
import { assertUniquePhysicalTargets } from './transaction/cleanup';
import type {
  RunMigrationImplResult,
  RunMigrationOptions,
  RunMigrationResult,
} from './types';
import {
  type MigrationDiskVerification,
  verifyMigrationFromDisk,
} from './verification';

async function assertPlanningInputsUnchanged(
  plan: FrozenMigrationPlan,
): Promise<void> {
  for (const [file, content] of plan.inputs) {
    if ((await readFile(file, 'utf8')) !== content)
      throw new Error(
        `Migration planning input changed before writing: ${file}`,
      );
  }
}

function createResult(options: {
  config: ResolvedLiminaConfig;
  plan: FrozenMigrationPlan;
  state: MigrationExecutionState;
  verification: MigrationDiskVerification;
}): RunMigrationResult {
  const { config, plan, state, verification } = options;
  if (plan.incomplete) state.incompleteFiles.push(config.configPath);
  return {
    checkerEntryCount: plan.topology.entries.length,
    hardlinkRewrittenFiles: state.execution.hardlinkRewrittenFiles,
    hardlinkSkippedFiles: state.execution.hardlinkSkippedFiles,
    modifiedFiles: state.execution.modifiedFiles,
    recursiveReferenceCount: Math.max(
      0,
      plan.topology.sources.length +
        plan.topology.solutions.length -
        plan.topology.entries.length,
    ),
    rootDir: config.rootDir,
    skippedFiles: state.execution.skippedFiles,
    processingComplete: true,
    inputConsumable:
      verification.consumable && state.incompleteFiles.length === 0,
    incompleteFiles: [...new Set(state.incompleteFiles)],
  };
}

async function publishReport(options: {
  config: ResolvedLiminaConfig;
  preflight: LiminaPreflightManager;
  plan: FrozenMigrationPlan;
  verification: MigrationDiskVerification;
  result: RunMigrationResult;
  runOptions: RunMigrationOptions;
}): Promise<void> {
  const reportPath = path.join(
    options.config.rootDir,
    '.limina/migration/latest.json',
  );
  try {
    await writeJsonAtomically(options.preflight.artifactNamespace, reportPath, {
      version: 1,
      result: options.result,
      records: options.plan.records,
      verification: options.verification,
    });
    options.result.reportPath = reportPath;
  } catch (error) {
    options.result.reportWarning = `Migration report publication failed: ${formatErrorMessage(error)}`;
    MigrationLogger.warn(options.result.reportWarning);
    options.runOptions.flow?.warn(options.result.reportWarning);
  }
}

export async function runMigrationImpl(
  config: ResolvedLiminaConfig,
  preflight: LiminaPreflightManager,
  options: { runOptions: RunMigrationOptions; task: MigrationTask },
): Promise<RunMigrationImplResult> {
  const plan = await createFrozenMigrationPlan(
    config,
    preflight.artifactNamespace,
  );
  const state = createExecutionState(plan);
  const roots = [
    ...new Set(await collectMigrationWorktreeRoots(plan.groups.flat())),
  ];
  // Freeze all physical snapshots before any mutation. Analysis never resumes after writing.
  const prepared = await prepareGroups({ plan, roots, state });
  assertUniquePhysicalTargets(
    prepared.flatMap((group) => [
      ...group.atomicSnapshots,
      ...group.hardlinkSnapshots,
    ]),
  );
  await confirmDirtyWorkspaceChanges({ roots, ...options });
  const hardlinkPolicy = await decideHardlinkPolicy({
    configRootDir: config.rootDir,
    hardlinkConfigPaths: prepared.flatMap((group) =>
      group.hardlinkSnapshots.map((snapshot) => snapshot.item.configPath),
    ),
    ...options,
  });
  await assertPlanningInputsUnchanged(plan);
  await executeGroups({ prepared, hardlinkPolicy, state });
  const verification = await verifyMigrationFromDisk(
    config,
    plan.topology,
    options.runOptions,
  );
  const result = createResult({ config, plan, state, verification });
  await publishReport({
    config,
    preflight,
    plan,
    verification,
    result,
    runOptions: options.runOptions,
  });
  for (const diagnostic of verification.diagnostics)
    MigrationLogger.warn(diagnostic);
  return { cleanupWarnings: state.execution.cleanupWarnings, result };
}
