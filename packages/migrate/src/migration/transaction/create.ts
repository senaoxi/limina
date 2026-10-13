import { ReplacementDriftError } from 'limina/internal/check-reporting/atomic-writer';
import { link, lstat, rmdir } from 'node:fs/promises';
import path from 'pathe';
import { assertAbsent, validateCreationParent } from './create-snapshot';
import { MigrationTransactionError } from './error';
import { createPreparedIdentity, normalizeStat } from './file-stat';
import { validateFile } from './file-validation';
import { resolveTransactionRuntimeOptions } from './setup';
import type {
  CreatedTargetSnapshot,
  MigrationTransactionExecutionResult,
  MigrationTransactionOptions,
  PreparedFileIdentity,
  PreparedMigrationPlan,
  TransactionRuntimeOptions,
} from './types';

interface StagedCreation {
  snapshot: CreatedTargetSnapshot;
  directory: string;
  nextPath: string;
  identity?: PreparedFileIdentity;
  created: boolean;
}
async function stageCreation(
  item: StagedCreation,
  runtime: TransactionRuntimeOptions,
): Promise<void> {
  const handle = await runtime.openFile(item.nextPath, 'wx', 0o666);
  try {
    const bytes = Buffer.from(item.snapshot.item.nextContent);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await runtime.writeAt({
        handle,
        bytes,
        offset,
        length: bytes.length - offset,
        position: offset,
      });
      if (result.bytesWritten <= 0)
        throw new Error('Migration create write made no progress.');
      offset += result.bytesWritten;
    }
    await handle.sync();
    item.identity = createPreparedIdentity(
      bytes,
      normalizeStat(await handle.stat({ bigint: true })),
    );
  } finally {
    await handle.close();
  }
  await validateFile({
    expected: item.identity!,
    filePath: item.nextPath,
    readFileBytes: runtime.readFileBytes,
    comparison: { compareObservedMtime: true, compareRestorableMtime: true },
  });
}
async function commitCreation(
  item: StagedCreation,
  runtime: TransactionRuntimeOptions,
): Promise<void> {
  await validateCreationParent(item.snapshot);
  // link is create-only and publishes fully written bytes. EEXIST never replaces another writer.
  await link(item.nextPath, item.snapshot.item.configPath);
  item.created = true;
  await runtime.removePath(item.nextPath);
  await validateCreation(item, runtime);
}
async function validateCreation(
  item: StagedCreation,
  runtime: TransactionRuntimeOptions,
): Promise<void> {
  await validateCreationParent(item.snapshot);
  const target = item.snapshot.item.configPath;
  if (!(await lstat(target)).isFile())
    throw new ReplacementDriftError(
      `Created migration target is no longer regular: ${target}`,
    );
  await validateFile({
    expected: item.identity!,
    filePath: target,
    readFileBytes: runtime.readFileBytes,
    comparison: { compareObservedMtime: true, compareRestorableMtime: true },
  });
}
async function rollbackCreation(
  item: StagedCreation,
  runtime: TransactionRuntimeOptions,
): Promise<Error | undefined> {
  try {
    await validateCreation(item, runtime);
    await runtime.removePath(item.snapshot.item.configPath);
  } catch (error) {
    return new Error(
      `Cannot prove ownership of created config; preserved ${item.snapshot.item.configPath}`,
      { cause: error },
    );
  }
  return undefined;
}
async function rollbackCreations(
  items: StagedCreation[],
  runtime: TransactionRuntimeOptions,
): Promise<Error[]> {
  const failures: Error[] = [];
  const created = items.filter((item) => item.created).toReversed();
  for (const item of created) {
    const failure = await rollbackCreation(item, runtime);
    if (failure) failures.push(failure);
  }
  return failures;
}
async function cleanupCreations(
  items: StagedCreation[],
  runtime: TransactionRuntimeOptions,
): Promise<Error[]> {
  const failures: Error[] = [];
  for (const item of items) {
    try {
      await runtime.removePath(item.nextPath);
      await rmdir(item.directory);
    } catch (error) {
      failures.push(
        new Error(
          `Unable to clean migration create artifacts at ${item.directory}`,
          { cause: error },
        ),
      );
    }
  }
  return failures;
}
interface CreationExecution {
  staged: StagedCreation[];
  options: MigrationTransactionOptions;
  runtime: TransactionRuntimeOptions;
}
async function prepareCreations(
  plan: PreparedMigrationPlan,
  execution: CreationExecution,
): Promise<void> {
  const { runtime, staged } = execution;
  for (const [index, snapshot] of plan.createSnapshots.entries()) {
    await validateCreationParent(snapshot);
    await assertAbsent(snapshot.item.configPath);
    const directory = await runtime.makeTransactionDirectory(
      path.join(path.dirname(snapshot.item.configPath), '.limina-migration-'),
    );
    const item = {
      snapshot,
      directory,
      nextPath: path.join(directory, 'create.next'),
      created: false,
    };
    staged.push(item);
    await stageCreation(item, runtime);
    await execution.options.afterPrepareItem?.(snapshot.item, index);
  }
}
function updateRecoveryFailures(error: unknown): Error[] {
  return error instanceof MigrationTransactionError
    ? error.rollbackFailures
    : [];
}
async function creationRecoveryFailures(
  execution: CreationExecution,
  updateFailures: Error[],
): Promise<Error[]> {
  if (updateFailures.length > 0)
    return [
      new Error(
        'Update rollback is incomplete; created isolation configuration is preserved.',
      ),
    ];
  return rollbackCreations(execution.staged, execution.runtime);
}
async function failCreationExecution(
  execution: CreationExecution,
  error: unknown,
): Promise<never> {
  const updateFailures = updateRecoveryFailures(error);
  const rollbackFailures = await creationRecoveryFailures(
    execution,
    updateFailures,
  );
  const cleanupFailures = await cleanupCreations(
    execution.staged,
    execution.runtime,
  );
  throw new MigrationTransactionError({
    primaryFailure: error,
    rollbackFailures: [...updateFailures, ...rollbackFailures],
    cleanupFailures,
  });
}
async function completeCreations(
  execution: CreationExecution,
  result: MigrationTransactionExecutionResult,
): Promise<MigrationTransactionExecutionResult> {
  const cleanupFailures = await cleanupCreations(
    execution.staged,
    execution.runtime,
  );
  return {
    ...result,
    modifiedFiles: [
      ...execution.staged.map((item) => item.snapshot.item.configPath),
      ...result.modifiedFiles,
    ],
    cleanupWarnings: [
      ...result.cleanupWarnings,
      ...cleanupFailures.map((error) => ({
        message: error.message,
        path: execution.staged[0]!.directory,
      })),
    ],
  };
}
async function commitCreations(execution: CreationExecution): Promise<void> {
  for (const item of execution.staged)
    await commitCreation(item, execution.runtime);
}
/**
Add only the create operations to the existing group transaction.
*/
export async function executeWithCreations(
  plan: PreparedMigrationPlan,
  options: MigrationTransactionOptions,
  applyUpdates: () => Promise<MigrationTransactionExecutionResult>,
): Promise<MigrationTransactionExecutionResult> {
  if (plan.createSnapshots.length === 0) return applyUpdates();
  const execution: CreationExecution = {
    runtime: resolveTransactionRuntimeOptions(options),
    staged: [],
    options,
  };
  try {
    await prepareCreations(plan, execution);
    await commitCreations(execution);
    return await completeCreations(execution, await applyUpdates());
  } catch (error) {
    return failCreationExecution(execution, error);
  }
}
