import type { FileHandle } from 'node:fs/promises';
import { rmdir } from 'node:fs/promises';
import { TerminalReplacementValidationError } from '../../../check-reporting/atomic-writer';
import { formatUnknownError, hasErrorCode } from './error';
import type {
  MigrationTransactionOptions,
  ModifiedTargetSnapshot,
  TransactionItem,
} from './types';

function getPhysicalIdentityKeys(snapshot: ModifiedTargetSnapshot): string[] {
  return [
    `canonical\0${snapshot.canonicalPath}`,
    `inode\0${snapshot.stat.dev}\0${snapshot.stat.ino}`,
  ];
}

function indexSnapshotPath(
  pathsByIdentity: Map<string, Set<string>>,
  snapshot: ModifiedTargetSnapshot,
): void {
  for (const key of getPhysicalIdentityKeys(snapshot)) {
    const paths = pathsByIdentity.get(key) ?? new Set<string>();
    paths.add(snapshot.item.configPath);
    pathsByIdentity.set(key, paths);
  }
}

function collectPhysicalConflicts(
  pathsByIdentity: ReadonlyMap<string, Set<string>>,
): string[][] {
  const uniqueConflicts = new Map<string, string[]>();
  for (const paths of pathsByIdentity.values()) {
    if (paths.size < 2) continue;
    const sortedPaths = [...paths].sort((left, right) =>
      left.localeCompare(right),
    );
    uniqueConflicts.set(sortedPaths.join('\0'), sortedPaths);
  }
  return [...uniqueConflicts.values()];
}

export function assertUniquePhysicalTargets(
  snapshots: readonly ModifiedTargetSnapshot[],
): void {
  const pathsByIdentity = new Map<string, Set<string>>();
  for (const snapshot of snapshots) {
    indexSnapshotPath(pathsByIdentity, snapshot);
  }
  const conflicts = collectPhysicalConflicts(pathsByIdentity);
  if (conflicts.length === 0) return;
  throw new TerminalReplacementValidationError(
    [
      'Migration write plan contains multiple logical paths for the same physical file:',
      ...conflicts.flatMap((paths) => paths.map((value) => `  - ${value}`)),
    ].join('\n'),
  );
}

export async function closeTrackedHandles(
  handles: Set<FileHandle>,
  failures: Error[],
): Promise<void> {
  for (const handle of handles) {
    try {
      await handle.close();
    } catch (error) {
      failures.push(
        new Error(
          `Unable to close transaction file: ${formatUnknownError(error)}`,
        ),
      );
    }
    handles.delete(handle);
  }
}

async function removeArtifact(options: {
  artifactPath: string;
  failures: Error[];
  removePath: NonNullable<MigrationTransactionOptions['removePath']>;
}): Promise<void> {
  try {
    await options.removePath(options.artifactPath);
  } catch (error) {
    options.failures.push(
      new Error(
        `Unable to remove migration artifact ${options.artifactPath}: ${formatUnknownError(error)}`,
      ),
    );
  }
}

async function cleanupItemArtifacts(options: {
  failures: Error[];
  item: TransactionItem;
  protectedItems: ReadonlySet<TransactionItem>;
  removePath: NonNullable<MigrationTransactionOptions['removePath']>;
}): Promise<void> {
  if (options.protectedItems.has(options.item)) return;
  for (const artifactPath of [
    options.item.nextPath,
    options.item.backupPath,
    options.item.rollbackPath,
  ]) {
    await removeArtifact({
      artifactPath,
      failures: options.failures,
      removePath: options.removePath,
    });
  }
}

function isMissingPathError(error: unknown): boolean {
  if (!hasErrorCode(error)) return false;
  return error.code === 'ENOENT';
}

async function cleanupDirectory(
  directory: string,
  failures: Error[],
): Promise<void> {
  try {
    await rmdir(directory);
  } catch (error) {
    if (isMissingPathError(error)) return;
    failures.push(
      new Error(
        `Unable to remove migration transaction directory ${directory}: ${formatUnknownError(error)}`,
      ),
    );
  }
}

export async function cleanupTransactionArtifacts(options: {
  directories: readonly string[];
  failures: Error[];
  items: readonly TransactionItem[];
  protectedItems: ReadonlySet<TransactionItem>;
  removePath: NonNullable<MigrationTransactionOptions['removePath']>;
}): Promise<void> {
  for (const item of options.items) {
    await cleanupItemArtifacts({ ...options, item });
  }
  const directories = [...new Set(options.directories)].toReversed();
  for (const directory of directories) {
    await cleanupDirectory(directory, options.failures);
  }
}
