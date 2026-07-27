import type { FileHandle } from 'node:fs/promises';
import { rename } from 'node:fs/promises';
import { replaceFileWithRetry } from '../../../check-reporting/atomic-writer';
import {
  assertUniquePhysicalTargets,
  cleanupTransactionArtifacts,
  closeTrackedHandles,
} from './cleanup';
import { formatUnknownError, MigrationTransactionError } from './error';
import { validateFile, validateOriginalTarget } from './file-validation';
import { finalizeCommittedState } from './finalize';
import {
  prepareTransactionItems,
  type TransactionPreparationState,
} from './prepare';
import { rollbackItem } from './rollback';
import {
  collectModifiedSnapshots,
  createEmptyMigrationResult,
  partitionMigrationPlan,
  resolveAllowedRoots,
  resolveTransactionRuntimeOptions,
} from './setup';
import type {
  MigrationTransactionExecutionResult,
  MigrationTransactionOptions,
  MigrationWritePlanItem,
  TransactionItem,
  TransactionItemState,
  TransactionRuntimeOptions,
} from './types';

function createPreparationState(): TransactionPreparationState {
  return {
    createdDirectories: [],
    items: [],
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
  snapshots: Awaited<ReturnType<typeof collectModifiedSnapshots>>;
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

function fullComparison() {
  return {
    compareObservedMtime: true,
    compareRestorableMtime: true,
  } as const;
}

async function commitItem(options: {
  item: TransactionItem;
  runtime: TransactionRuntimeOptions;
  transactionOptions: MigrationTransactionOptions;
}): Promise<void> {
  await replaceFileWithRetry(
    options.item.nextPath,
    options.item.snapshot.item.configPath,
    {
      beforeAttempt: async () => {
        await validateOriginalTarget({
          snapshot: options.item.snapshot,
          validation: options.runtime,
        });
        await validateFile({
          comparison: fullComparison(),
          expected: options.item.nextIdentity!,
          filePath: options.item.nextPath,
          readFileBytes: options.runtime.readFileBytes,
        });
      },
      replace: options.transactionOptions.replace ?? rename,
      retryDelaysMs: options.runtime.retryDelaysMs,
    },
  );
  options.item.state = 'replaced';
}

async function commitAll(options: {
  runtime: TransactionRuntimeOptions;
  state: TransactionPreparationState;
  transactionOptions: MigrationTransactionOptions;
}): Promise<void> {
  for (const item of options.state.items) {
    await commitItem({ ...options, item });
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

async function rollbackReplacedItem(options: {
  failures: Error[];
  item: TransactionItem;
  runtime: TransactionRuntimeOptions;
  transactionOptions: MigrationTransactionOptions;
  trackedHandles: Set<FileHandle>;
}): Promise<void> {
  if (options.item.state !== 'replaced') {
    options.item.state = 'never-replaced';
    return;
  }
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

async function rollbackAll(options: {
  runtime: TransactionRuntimeOptions;
  state: TransactionPreparationState;
  transactionOptions: MigrationTransactionOptions;
}): Promise<Error[]> {
  const failures: Error[] = [];
  for (const item of options.state.items.toReversed()) {
    await rollbackReplacedItem({
      failures,
      item,
      runtime: options.runtime,
      transactionOptions: options.transactionOptions,
      trackedHandles: options.state.trackedHandles,
    });
  }
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

export async function executeMigrationWritePlan(
  allowedRootDirs: string | readonly string[],
  plan: readonly MigrationWritePlanItem[],
  transactionOptions: MigrationTransactionOptions = {},
): Promise<MigrationTransactionExecutionResult> {
  const { modifiedItems, skippedFiles } = partitionMigrationPlan(plan);
  if (modifiedItems.length === 0) {
    return createEmptyMigrationResult(skippedFiles);
  }
  const runtime = resolveTransactionRuntimeOptions(transactionOptions);
  const allowedRoots = await resolveAllowedRoots(allowedRootDirs);
  const snapshots = await collectModifiedSnapshots({
    allowedRoots: allowedRoots.roots,
    items: modifiedItems,
    runtime,
  });
  assertUniquePhysicalTargets(snapshots);
  const state = createPreparationState();
  await prepareAll({ runtime, snapshots, state, transactionOptions });
  await commitPreparedState({ runtime, state, transactionOptions });
  return finalizeCommittedState({
    fallbackPath: allowedRoots.normalizedRootDirs[0]!,
    modifiedItems,
    runtime,
    skippedFiles,
    state,
  });
}
