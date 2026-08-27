import type { FileHandle } from 'node:fs/promises';
import { cleanupTransactionArtifacts, closeTrackedHandles } from './cleanup';
import { commitAll } from './commit';
import { formatUnknownError, MigrationTransactionError } from './error';
import { finalizeCommittedState } from './finalize';
import {
  prepareTransactionItems,
  type TransactionPreparationState,
} from './prepare';
import { rollbackItem } from './rollback';
import {
  createEmptyMigrationResult,
  prepareMigrationWritePlan,
  resolveTransactionRuntimeOptions,
} from './setup';
import type {
  MigrationTransactionExecutionResult,
  MigrationTransactionOptions,
  MigrationWritePlanItem,
  PreparedMigrationPlan,
  TransactionItem,
  TransactionItemState,
  TransactionRuntimeOptions,
} from './types';

function createPreparationState(): TransactionPreparationState {
  return {
    createdDirectories: [],
    items: [],
    mutationOrder: [],
    trackedHandles: new Set<FileHandle>(),
  };
}

async function cleanupState(options: {
  failures: Error[];
  protectedItems: ReadonlySet<TransactionItem>;
  runtime: TransactionRuntimeOptions;
  state: TransactionPreparationState;
}): Promise<void> {
  await closeTrackedHandles(options.state.trackedHandles, options.failures);
  await cleanupTransactionArtifacts({
    directories: options.state.createdDirectories,
    failures: options.failures,
    items: options.state.items,
    protectedItems: options.protectedItems,
    removePath: options.runtime.removePath,
  });
}

async function prepareAll(options: {
  runtime: TransactionRuntimeOptions;
  snapshots: PreparedMigrationPlan['atomicSnapshots'];
  state: TransactionPreparationState;
  transactionOptions: MigrationTransactionOptions;
}): Promise<void> {
  try {
    await prepareTransactionItems({
      afterPrepareItem: options.transactionOptions.afterPrepareItem,
      runtime: options.runtime,
      snapshots: options.snapshots,
      state: options.state,
    });
  } catch (error) {
    const cleanupFailures: Error[] = [];
    await cleanupState({
      failures: cleanupFailures,
      protectedItems: new Set(),
      runtime: options.runtime,
      state: options.state,
    });
    throw new MigrationTransactionError({
      cleanupFailures,
      primaryFailure: error,
    });
  }
}

function markRollbackFailure(
  item: TransactionItem,
  error: unknown,
  failures: Error[],
): void {
  const rollbackState = item.state as TransactionItemState;
  if (rollbackState !== 'rollback-postverify-failed') {
    item.state = 'rollback-failed';
  }
  failures.push(
    new Error(
      `Unable to roll back ${item.snapshot.item.configPath}; recovery backup retained at ${item.backupPath}: ${formatUnknownError(error)}`,
      { cause: error },
    ),
  );
}

async function rollbackMutatedItem(options: {
  failures: Error[];
  item: TransactionItem;
  runtime: TransactionRuntimeOptions;
  transactionOptions: MigrationTransactionOptions;
  trackedHandles: Set<FileHandle>;
}): Promise<void> {
  const existingFailure = getExistingRecoveryFailure(options.item);
  if (existingFailure !== undefined) {
    options.failures.push(existingFailure);
    return;
  }
  if (!shouldRollbackItem(options.item)) return;
  await attemptRollbackItem(options);
}

async function attemptRollbackItem(options: {
  failures: Error[];
  item: TransactionItem;
  runtime: TransactionRuntimeOptions;
  transactionOptions: MigrationTransactionOptions;
  trackedHandles: Set<FileHandle>;
}): Promise<void> {
  try {
    await rollbackItem({
      item: options.item,
      openFile: options.runtime.openFile,
      readFileBytes: options.runtime.readFileBytes,
      replace: options.transactionOptions.replace,
      retryDelaysMs: options.runtime.retryDelaysMs,
      trackedHandles: options.trackedHandles,
    });
  } catch (error) {
    markRollbackFailure(options.item, error, options.failures);
  }
}

function getExistingRecoveryFailure(item: TransactionItem): Error | undefined {
  if (item.state !== 'rollback-failed') return undefined;
  return (
    item.recoveryFailure ??
    new Error(
      `Unable to recover ${item.snapshot.item.configPath}; recovery backup retained at ${item.backupPath}`,
    )
  );
}

function shouldRollbackItem(item: TransactionItem): boolean {
  return item.state === 'mutated';
}

function markNeverMutated(item: TransactionItem): void {
  if (item.state === 'prepared') item.state = 'never-mutated';
}

async function rollbackAll(options: {
  runtime: TransactionRuntimeOptions;
  state: TransactionPreparationState;
  transactionOptions: MigrationTransactionOptions;
}): Promise<Error[]> {
  const failures: Error[] = [];
  for (const item of options.state.mutationOrder.toReversed()) {
    await rollbackMutatedItem({
      failures,
      item,
      runtime: options.runtime,
      transactionOptions: options.transactionOptions,
      trackedHandles: options.state.trackedHandles,
    });
  }
  for (const item of options.state.items) markNeverMutated(item);
  return failures;
}

function getProtectedItems(
  items: readonly TransactionItem[],
): Set<TransactionItem> {
  return new Set(
    items.filter((item) =>
      ['rollback-failed', 'rollback-postverify-failed'].includes(item.state),
    ),
  );
}

async function handleCommitFailure(options: {
  error: unknown;
  runtime: TransactionRuntimeOptions;
  state: TransactionPreparationState;
  transactionOptions: MigrationTransactionOptions;
}): Promise<never> {
  const rollbackFailures = await rollbackAll(options);
  const cleanupFailures: Error[] = [];
  await cleanupState({
    failures: cleanupFailures,
    protectedItems: getProtectedItems(options.state.items),
    runtime: options.runtime,
    state: options.state,
  });
  throw new MigrationTransactionError({
    cleanupFailures,
    primaryFailure: options.error,
    rollbackFailures,
  });
}

async function commitPreparedState(options: {
  runtime: TransactionRuntimeOptions;
  state: TransactionPreparationState;
  transactionOptions: MigrationTransactionOptions;
}): Promise<void> {
  try {
    await commitAll(options);
  } catch (error) {
    await handleCommitFailure({ ...options, error });
  }
}

function assertHardlinkPolicyAvailable(
  plan: PreparedMigrationPlan,
  hardlinkPolicy: MigrationTransactionOptions['hardlinkPolicy'],
): void {
  if (plan.hardlinkSnapshots.length > 0 && hardlinkPolicy === undefined) {
    throw new Error(
      'Hard-linked migration targets require an explicit skip or rewrite policy.',
    );
  }
}

function selectHardlinkSnapshots(
  plan: PreparedMigrationPlan,
  hardlinkPolicy: MigrationTransactionOptions['hardlinkPolicy'],
) {
  if (hardlinkPolicy === 'rewrite') return plan.hardlinkSnapshots;
  return [];
}

function collectHardlinkSkippedFiles(
  plan: PreparedMigrationPlan,
  hardlinkPolicy: MigrationTransactionOptions['hardlinkPolicy'],
): string[] {
  if (hardlinkPolicy !== 'skip') return [];
  return plan.hardlinkSnapshots.map((snapshot) => snapshot.item.configPath);
}

function selectSnapshots(
  plan: PreparedMigrationPlan,
  hardlinkPolicy: MigrationTransactionOptions['hardlinkPolicy'],
) {
  assertHardlinkPolicyAvailable(plan, hardlinkPolicy);
  const selectedHardlinks = selectHardlinkSnapshots(plan, hardlinkPolicy);
  return {
    hardlinkSkippedFiles: collectHardlinkSkippedFiles(plan, hardlinkPolicy),
    selectedSnapshots: [...plan.atomicSnapshots, ...selectedHardlinks],
  };
}

export async function executePreparedMigrationPlan(
  plan: PreparedMigrationPlan,
  transactionOptions: MigrationTransactionOptions = {},
): Promise<MigrationTransactionExecutionResult> {
  const selection = selectSnapshots(plan, transactionOptions.hardlinkPolicy);
  if (selection.selectedSnapshots.length === 0) {
    return {
      ...createEmptyMigrationResult(plan.skippedFiles),
      hardlinkSkippedFiles: selection.hardlinkSkippedFiles,
    };
  }
  const runtime = resolveTransactionRuntimeOptions(transactionOptions);
  const state = createPreparationState();
  await prepareAll({
    runtime,
    snapshots: selection.selectedSnapshots,
    state,
    transactionOptions,
  });
  await commitPreparedState({ runtime, state, transactionOptions });
  const modifiedItems = selection.selectedSnapshots.map(
    (snapshot) => snapshot.item,
  );
  return finalizeCommittedState({
    fallbackPath: plan.normalizedRootDirs[0]!,
    hardlinkRewrittenFiles: state.items
      .filter((item) => item.snapshot.writeStrategy === 'in-place')
      .map((item) => item.snapshot.item.configPath),
    hardlinkSkippedFiles: selection.hardlinkSkippedFiles,
    modifiedItems,
    runtime,
    skippedFiles: plan.skippedFiles,
    state,
  });
}

export async function executeMigrationWritePlan(
  allowedRootDirs: string | readonly string[],
  plan: readonly MigrationWritePlanItem[],
  transactionOptions: MigrationTransactionOptions = {},
): Promise<MigrationTransactionExecutionResult> {
  const preparedPlan = await prepareMigrationWritePlan(
    allowedRootDirs,
    plan,
    transactionOptions,
  );
  return executePreparedMigrationPlan(preparedPlan, transactionOptions);
}
