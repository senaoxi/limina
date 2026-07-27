import type { FileHandle } from 'node:fs/promises';
import { chmod, stat } from 'node:fs/promises';
import path from 'pathe';
import { prepareFile } from './file-preparation';
import { assertEqual, normalizeStat } from './file-stat';
import type {
  MigrationTransactionOptions,
  ModifiedTargetSnapshot,
  TransactionItem,
  TransactionRuntimeOptions,
} from './types';

export interface TransactionPreparationState {
  createdDirectories: string[];
  items: TransactionItem[];
  trackedHandles: Set<FileHandle>;
}

async function secureTransactionDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  await chmod(directory, 0o700);
  const directoryStat = normalizeStat(await stat(directory, { bigint: true }));
  assertEqual({
    actual: directoryStat.permissionMode,
    expected: 0o700,
    filePath: directory,
    label: 'transaction directory mode',
  });
}

async function getOrCreateTransactionDirectory(options: {
  directoriesByParent: Map<string, string>;
  parentDirectory: string;
  runtime: TransactionRuntimeOptions;
  state: TransactionPreparationState;
}): Promise<string> {
  const existing = options.directoriesByParent.get(options.parentDirectory);
  if (existing !== undefined) return existing;
  const directory = await options.runtime.makeTransactionDirectory(
    path.join(options.parentDirectory, '.limina-migration-'),
  );
  await secureTransactionDirectory(directory);
  options.directoriesByParent.set(options.parentDirectory, directory);
  options.state.createdDirectories.push(directory);
  return directory;
}

function createTransactionItem(options: {
  index: number;
  snapshot: ModifiedTargetSnapshot;
  transactionDirectory: string;
}): TransactionItem {
  return {
    backupPath: path.join(
      options.transactionDirectory,
      `${options.index}.backup`,
    ),
    nextPath: path.join(options.transactionDirectory, `${options.index}.next`),
    rollbackPath: path.join(
      options.transactionDirectory,
      `${options.index}.rollback`,
    ),
    snapshot: options.snapshot,
    state: 'preparing',
    transactionDirectory: options.transactionDirectory,
  };
}

async function prepareNextIdentity(options: {
  item: TransactionItem;
  runtime: TransactionRuntimeOptions;
  trackedHandles: Set<FileHandle>;
}): Promise<void> {
  options.item.nextIdentity = await prepareFile({
    bytes: Buffer.from(options.item.snapshot.item.nextContent),
    filePath: options.item.nextPath,
    openFile: options.runtime.openFile,
    readFileBytes: options.runtime.readFileBytes,
    restoreTimestamp: false,
    snapshot: options.item.snapshot,
    trackedHandles: options.trackedHandles,
  });
}

async function prepareBackupIdentity(options: {
  item: TransactionItem;
  runtime: TransactionRuntimeOptions;
  trackedHandles: Set<FileHandle>;
}): Promise<void> {
  options.item.backupIdentity = await prepareFile({
    bytes: options.item.snapshot.item.originalBytes,
    filePath: options.item.backupPath,
    openFile: options.runtime.openFile,
    readFileBytes: options.runtime.readFileBytes,
    restoreTimestamp: true,
    snapshot: options.item.snapshot,
    trackedHandles: options.trackedHandles,
  });
}

async function prepareTransactionItem(options: {
  afterPrepareItem: MigrationTransactionOptions['afterPrepareItem'];
  index: number;
  item: TransactionItem;
  runtime: TransactionRuntimeOptions;
  trackedHandles: Set<FileHandle>;
}): Promise<void> {
  await prepareNextIdentity(options);
  await prepareBackupIdentity(options);
  options.item.state = 'prepared';
  if (options.afterPrepareItem !== undefined) {
    await options.afterPrepareItem(options.item.snapshot.item, options.index);
  }
}

export async function prepareTransactionItems(options: {
  afterPrepareItem: MigrationTransactionOptions['afterPrepareItem'];
  runtime: TransactionRuntimeOptions;
  snapshots: readonly ModifiedTargetSnapshot[];
  state: TransactionPreparationState;
}): Promise<void> {
  const directoriesByParent = new Map<string, string>();
  for (const [index, snapshot] of options.snapshots.entries()) {
    const parentDirectory = path.dirname(snapshot.item.configPath);
    const transactionDirectory = await getOrCreateTransactionDirectory({
      directoriesByParent,
      parentDirectory,
      runtime: options.runtime,
      state: options.state,
    });
    const item = createTransactionItem({
      index,
      snapshot,
      transactionDirectory,
    });
    options.state.items.push(item);
    await prepareTransactionItem({
      afterPrepareItem: options.afterPrepareItem,
      index,
      item,
      runtime: options.runtime,
      trackedHandles: options.state.trackedHandles,
    });
  }
}
