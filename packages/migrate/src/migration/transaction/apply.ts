import { executeWithCreations } from './create';
import { executePreparedUpdates } from './execution';
import { createEmptyMigrationResult, prepareMigrationWritePlan } from './setup';
import type {
  MigrationTransactionExecutionResult,
  MigrationTransactionOptions,
  MigrationWritePlanItem,
  PreparedMigrationPlan,
} from './types';

function hasSkippedCreateGroup(
  plan: PreparedMigrationPlan,
  options: MigrationTransactionOptions,
): boolean {
  return [
    options.hardlinkPolicy === 'skip',
    plan.hardlinkSnapshots.length > 0,
    plan.createSnapshots.length > 0,
  ].every(Boolean);
}
function assertHardlinkPolicy(
  plan: PreparedMigrationPlan,
  options: MigrationTransactionOptions,
): void {
  if (options.hardlinkPolicy === undefined && plan.hardlinkSnapshots.length > 0)
    throw new Error(
      'Hard-linked migration targets require an explicit skip or rewrite policy.',
    );
}
export async function executePreparedMigrationPlan(
  plan: PreparedMigrationPlan,
  options: MigrationTransactionOptions = {},
): Promise<MigrationTransactionExecutionResult> {
  assertHardlinkPolicy(plan, options);
  if (hasSkippedCreateGroup(plan, options))
    return {
      ...createEmptyMigrationResult([
        ...plan.skippedFiles,
        ...plan.createSnapshots.map((snapshot) => snapshot.item.configPath),
        ...plan.atomicSnapshots.map((snapshot) => snapshot.item.configPath),
      ]),
      hardlinkSkippedFiles: plan.hardlinkSnapshots.map(
        (snapshot) => snapshot.item.configPath,
      ),
    };
  return executeWithCreations(plan, options, () =>
    executePreparedUpdates(plan, options),
  );
}
export async function executeMigrationWritePlan(
  allowedRootDirectories: string | readonly string[],
  plan: readonly MigrationWritePlanItem[],
  options: MigrationTransactionOptions = {},
): Promise<MigrationTransactionExecutionResult> {
  return executePreparedMigrationPlan(
    await prepareMigrationWritePlan(allowedRootDirectories, plan, options),
    options,
  );
}
