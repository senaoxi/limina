import { cleanupTransactionArtifacts, closeTrackedHandles } from './cleanup';
import type { TransactionPreparationState } from './prepare';
import type {
  MigrationCleanupWarning,
  MigrationTransactionExecutionResult,
  MigrationWritePlanItem,
  TransactionItem,
  TransactionRuntimeOptions,
} from './types';

function createCleanupWarnings(options: {
  failures: readonly Error[];
  fallbackPath: string;
  items: readonly TransactionItem[];
}): MigrationCleanupWarning[] {
  return options.failures.map((failure) => {
    const matchingItem = options.items.find((item) =>
      failure.message.includes(item.transactionDirectory),
    );
    return {
      message: failure.message,
      path: matchingItem?.transactionDirectory ?? options.fallbackPath,
    };
  });
}

async function cleanupCommittedState(options: {
  failures: Error[];
  runtime: TransactionRuntimeOptions;
  state: TransactionPreparationState;
}): Promise<void> {
  await closeTrackedHandles(options.state.trackedHandles, options.failures);
  await cleanupTransactionArtifacts({
    directories: options.state.createdDirectories,
    failures: options.failures,
    items: options.state.items,
    protectedItems: new Set(),
    removePath: options.runtime.removePath,
  });
}

export async function finalizeCommittedState(options: {
  fallbackPath: string;
  modifiedItems: readonly MigrationWritePlanItem[];
  runtime: TransactionRuntimeOptions;
  skippedFiles: string[];
  state: TransactionPreparationState;
}): Promise<MigrationTransactionExecutionResult> {
  for (const item of options.state.items) item.state = 'committed';
  const cleanupFailures: Error[] = [];
  await cleanupCommittedState({
    failures: cleanupFailures,
    runtime: options.runtime,
    state: options.state,
  });
  return {
    cleanupWarnings: createCleanupWarnings({
      failures: cleanupFailures,
      fallbackPath: options.fallbackPath,
      items: options.state.items,
    }),
    modifiedFiles: options.modifiedItems.map((item) => item.configPath),
    skippedFiles: options.skippedFiles,
  };
}
