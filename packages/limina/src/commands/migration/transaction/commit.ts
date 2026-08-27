import type { FileHandle } from 'node:fs/promises';
import { rename } from 'node:fs/promises';
import { replaceFileWithRetry } from '../../../check-reporting/atomic-writer';
import { formatUnknownError } from './error';
import { validateFile, validateOriginalTarget } from './file-validation';
import {
  captureCommittedInPlaceIdentity,
  closeTargetHandle,
  openValidatedInPlaceTarget,
  rewriteOpenTarget,
  validateFailedInPlaceTargetIsOriginal,
} from './in-place';
import type { TransactionPreparationState } from './prepare';
import type {
  MigrationTransactionOptions,
  TransactionItem,
  TransactionRuntimeOptions,
} from './types';

function fullComparison() {
  return {
    compareObservedMtime: true,
    compareRestorableMtime: true,
  } as const;
}

async function commitAtomicItem(options: {
  item: TransactionItem;
  runtime: TransactionRuntimeOptions;
  state: TransactionPreparationState;
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
  options.item.state = 'mutated';
  options.state.mutationOrder.push(options.item);
}

function createRecoveryFailure(item: TransactionItem, error: unknown): Error {
  return new Error(
    `Unable to confirm failed hard-linked target ${item.snapshot.item.configPath} remains unchanged; current target preserved and recovery backup retained at ${item.backupPath}: ${formatUnknownError(error)}`,
    { cause: error },
  );
}

function createPostWriteVerificationFailure(
  item: TransactionItem,
  error: unknown,
): Error {
  return new Error(
    `Unable to verify committed hard-linked target ${item.snapshot.item.configPath}; current target preserved and recovery backup retained at ${item.backupPath}: ${formatUnknownError(error)}`,
    { cause: error },
  );
}

async function finishUnchangedInPlaceFailure(options: {
  handle: FileHandle;
  item: TransactionItem;
  runtime: TransactionRuntimeOptions;
  state: TransactionPreparationState;
}): Promise<void> {
  await validateFailedInPlaceTargetIsOriginal(options);
  await closeTargetHandle({
    handle: options.handle,
    item: options.item,
    trackedHandles: options.state.trackedHandles,
  });
  options.item.state = 'rolled-back';
}

async function recoverFailedInPlaceWrite(options: {
  handle: FileHandle;
  item: TransactionItem;
  primaryError: unknown;
  runtime: TransactionRuntimeOptions;
  state: TransactionPreparationState;
}): Promise<never> {
  try {
    await finishUnchangedInPlaceFailure(options);
  } catch (recoveryError) {
    options.item.recoveryFailure = createRecoveryFailure(
      options.item,
      recoveryError,
    );
    options.item.state = 'rollback-failed';
  }
  throw options.primaryError;
}

async function writeInPlaceItem(options: {
  handle: FileHandle;
  item: TransactionItem;
  runtime: TransactionRuntimeOptions;
  state: TransactionPreparationState;
}): Promise<void> {
  try {
    await rewriteOpenTarget({
      bytes: Buffer.from(options.item.snapshot.item.nextContent),
      handle: options.handle,
      restoreTimestamp: false,
      snapshot: options.item.snapshot,
      writeAt: options.runtime.writeAt,
    });
  } catch (primaryError) {
    await recoverFailedInPlaceWrite({ ...options, primaryError });
  }
}

async function captureInPlaceItem(options: {
  handle: FileHandle;
  item: TransactionItem;
  runtime: TransactionRuntimeOptions;
  state: TransactionPreparationState;
}): Promise<void> {
  try {
    options.item.writtenIdentity = await captureCommittedInPlaceIdentity({
      handle: options.handle,
      item: options.item,
      runtime: options.runtime,
      trackedHandles: options.state.trackedHandles,
    });
    options.item.state = 'mutated';
  } catch (error) {
    options.item.recoveryFailure = createPostWriteVerificationFailure(
      options.item,
      error,
    );
    options.item.state = 'rollback-failed';
    throw error;
  }
}

async function commitInPlaceItem(options: {
  item: TransactionItem;
  runtime: TransactionRuntimeOptions;
  state: TransactionPreparationState;
}): Promise<void> {
  const handle = await openValidatedInPlaceTarget({
    expected: options.item.snapshot,
    item: options.item,
    runtime: options.runtime,
    trackedHandles: options.state.trackedHandles,
  });
  options.item.state = 'mutation-started';
  options.state.mutationOrder.push(options.item);
  await writeInPlaceItem({ ...options, handle });
  await captureInPlaceItem({ ...options, handle });
}

async function commitAtomicItems(options: {
  runtime: TransactionRuntimeOptions;
  state: TransactionPreparationState;
  transactionOptions: MigrationTransactionOptions;
}): Promise<void> {
  const items = options.state.items.filter(
    (item) => item.snapshot.writeStrategy === 'atomic-replace',
  );
  for (const item of items) await commitAtomicItem({ ...options, item });
}

async function commitInPlaceItems(options: {
  runtime: TransactionRuntimeOptions;
  state: TransactionPreparationState;
}): Promise<void> {
  const items = options.state.items.filter(
    (item) => item.snapshot.writeStrategy === 'in-place',
  );
  for (const item of items) await commitInPlaceItem({ ...options, item });
}

export async function commitAll(options: {
  runtime: TransactionRuntimeOptions;
  state: TransactionPreparationState;
  transactionOptions: MigrationTransactionOptions;
}): Promise<void> {
  await commitAtomicItems(options);
  await commitInPlaceItems(options);
}
