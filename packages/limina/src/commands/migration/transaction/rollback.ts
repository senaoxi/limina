import type { FileHandle } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import {
  replaceFileWithRetry,
  RetryableReplacementValidationIoError,
} from '../../../check-reporting/atomic-writer';
import { prepareFile } from './file-preparation';
import {
  assertContentMatches,
  assertEqual,
  normalizeStat,
  validationIo,
} from './file-stat';
import { validateCanonicalTarget, validateFile } from './file-validation';
import type { MigrationTransactionOptions, TransactionItem } from './types';

function shouldRetryVerification(
  error: unknown,
  attempt: number,
  retryDelaysMs: readonly number[],
): boolean {
  if (!(error instanceof RetryableReplacementValidationIoError)) return false;
  return attempt < retryDelaysMs.length;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function runVerificationAttempt(
  operation: () => Promise<void>,
): Promise<unknown | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    return error;
  }
}

async function retryVerification(options: {
  attempt: number;
  error: unknown;
  operation: () => Promise<void>;
  retryDelaysMs: readonly number[];
}): Promise<void> {
  if (
    !shouldRetryVerification(
      options.error,
      options.attempt,
      options.retryDelaysMs,
    )
  ) {
    throw options.error;
  }
  await delay(options.retryDelaysMs[options.attempt]!);
  await verifyWithRetry(
    options.operation,
    options.retryDelaysMs,
    options.attempt + 1,
  );
}

async function verifyWithRetry(
  operation: () => Promise<void>,
  retryDelaysMs: readonly number[],
  attempt = 0,
): Promise<void> {
  const error = await runVerificationAttempt(operation);
  if (error === null) return;
  await retryVerification({ attempt, error, operation, retryDelaysMs });
}

function requireRollbackIdentities(item: TransactionItem): void {
  if (item.backupIdentity !== undefined && item.nextIdentity !== undefined) {
    return;
  }
  throw new Error(
    `Rollback identities are missing for ${item.snapshot.item.configPath}`,
  );
}

function fullComparison() {
  return {
    compareObservedMtime: true,
    compareRestorableMtime: true,
  } as const;
}

async function prepareRollbackFile(options: {
  item: TransactionItem;
  openFile: NonNullable<MigrationTransactionOptions['openFile']>;
  readFileBytes: NonNullable<MigrationTransactionOptions['readFileBytes']>;
  trackedHandles: Set<FileHandle>;
}): Promise<void> {
  options.item.rollbackIdentity = await prepareFile({
    bytes: options.item.snapshot.item.originalBytes,
    filePath: options.item.rollbackPath,
    openFile: options.openFile,
    readFileBytes: options.readFileBytes,
    restoreTimestamp: true,
    snapshot: options.item.snapshot,
    trackedHandles: options.trackedHandles,
  });
}

async function validateRollbackAttempt(options: {
  item: TransactionItem;
  readFileBytes: NonNullable<MigrationTransactionOptions['readFileBytes']>;
}): Promise<void> {
  const item = options.item;
  await validateCanonicalTarget(item.snapshot);
  await validateFile({
    comparison: fullComparison(),
    expected: item.nextIdentity!,
    filePath: item.snapshot.item.configPath,
    readFileBytes: options.readFileBytes,
  });
  await validateFile({
    comparison: fullComparison(),
    expected: item.rollbackIdentity!,
    filePath: item.rollbackPath,
    readFileBytes: options.readFileBytes,
  });
  await validateFile({
    comparison: fullComparison(),
    expected: item.backupIdentity!,
    filePath: item.backupPath,
    readFileBytes: options.readFileBytes,
  });
}

async function replaceRollbackTarget(options: {
  item: TransactionItem;
  readFileBytes: NonNullable<MigrationTransactionOptions['readFileBytes']>;
  replace?: MigrationTransactionOptions['replace'];
  retryDelaysMs: readonly number[];
}): Promise<void> {
  await replaceFileWithRetry(
    options.item.rollbackPath,
    options.item.snapshot.item.configPath,
    {
      beforeAttempt: () => validateRollbackAttempt(options),
      replace: options.replace,
      retryDelaysMs: options.retryDelaysMs,
    },
  );
}

async function readRestoredTarget(options: {
  item: TransactionItem;
  readFileBytes: NonNullable<MigrationTransactionOptions['readFileBytes']>;
}) {
  const filePath = options.item.snapshot.item.configPath;
  const restoredStat = normalizeStat(
    await validationIo(`Unable to stat restored target ${filePath}`, () =>
      stat(filePath, { bigint: true }),
    ),
  );
  const restoredBytes = await validationIo(
    `Unable to read restored target ${filePath}`,
    () => options.readFileBytes(filePath),
  );
  return { restoredBytes, restoredStat };
}

async function verifyRestoredTarget(options: {
  item: TransactionItem;
  readFileBytes: NonNullable<MigrationTransactionOptions['readFileBytes']>;
}): Promise<void> {
  await validateCanonicalTarget(options.item.snapshot);
  const { restoredBytes, restoredStat } = await readRestoredTarget(options);
  const snapshot = options.item.snapshot;
  const filePath = snapshot.item.configPath;
  assertContentMatches({ bytes: restoredBytes, expected: snapshot, filePath });
  const fields: readonly [unknown, unknown, string][] = [
    [
      restoredStat.permissionMode,
      snapshot.stat.permissionMode,
      'permission mode',
    ],
    [restoredStat.uid, snapshot.stat.uid, 'uid'],
    [restoredStat.gid, snapshot.stat.gid, 'gid'],
    [
      restoredStat.timestamp.restorableMtimeMs,
      snapshot.stat.timestamp.restorableMtimeMs,
      'restorable mtime',
    ],
  ];
  for (const [actual, expected, label] of fields) {
    assertEqual({ actual, expected, filePath, label });
  }
}

async function postVerifyRollback(options: {
  item: TransactionItem;
  readFileBytes: NonNullable<MigrationTransactionOptions['readFileBytes']>;
  retryDelaysMs: readonly number[];
}): Promise<void> {
  try {
    await verifyWithRetry(
      () => verifyRestoredTarget(options),
      options.retryDelaysMs,
    );
  } catch (error) {
    options.item.state = 'rollback-postverify-failed';
    throw error;
  }
}

export async function rollbackItem(options: {
  item: TransactionItem;
  openFile: NonNullable<MigrationTransactionOptions['openFile']>;
  readFileBytes: NonNullable<MigrationTransactionOptions['readFileBytes']>;
  replace?: MigrationTransactionOptions['replace'];
  retryDelaysMs: readonly number[];
  trackedHandles: Set<FileHandle>;
}): Promise<void> {
  requireRollbackIdentities(options.item);
  await validateFile({
    comparison: fullComparison(),
    expected: options.item.backupIdentity!,
    filePath: options.item.backupPath,
    readFileBytes: options.readFileBytes,
  });
  await prepareRollbackFile(options);
  await replaceRollbackTarget(options);
  await postVerifyRollback(options);
  options.item.state = 'rolled-back';
}
