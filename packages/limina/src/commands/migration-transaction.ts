import { isPathInsideDirectory, normalizeAbsolutePath } from '#utils/path';
import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import {
  chmod,
  type FileHandle,
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
} from 'node:fs/promises';
import path from 'pathe';
import {
  replaceFileWithRetry,
  ReplacementDriftError,
  RetryableReplacementValidationIoError,
  TerminalReplacementValidationError,
} from '../check-reporting/atomic-writer';

const retryableAccessCodes = new Set(['EACCES', 'EBUSY', 'EPERM']);
const verificationRetryDelaysMs = [10, 25, 50, 100] as const;
const nanosecondsPerMillisecond = 1_000_000n;

export interface MigrationWritePlanItem {
  configPath: string;
  nextContent: string;
  originalBytes: Buffer;
  originalContent: string;
  status: 'modified' | 'skipped';
}

export interface MigrationCleanupWarning {
  message: string;
  path: string;
}

export interface MigrationTransactionExecutionResult {
  cleanupWarnings: MigrationCleanupWarning[];
  modifiedFiles: string[];
  skippedFiles: string[];
}

export interface OriginalTimestampSnapshot {
  observedMtimeNs?: bigint;
  restorableMtimeMs: number;
}

interface NormalizedFileStat {
  atimeMs: number;
  chownGid?: number;
  chownUid?: number;
  dev: bigint;
  fileType: 'directory' | 'other' | 'regular' | 'symlink';
  gid?: bigint;
  ino: bigint;
  nlink: bigint;
  permissionMode: number;
  rawMode: bigint;
  size: bigint;
  timestamp: OriginalTimestampSnapshot;
  uid?: bigint;
}

interface FileContentIdentity {
  byteLength: number;
  sha256: string;
}

interface PreparedFileIdentity extends FileContentIdentity {
  stat: NormalizedFileStat;
}

interface ModifiedTargetSnapshot extends PreparedFileIdentity {
  allowedCanonicalRootDir: string;
  allowedRootDir: string;
  canonicalPath: string;
  item: MigrationWritePlanItem;
}

type TransactionItemState =
  | 'committed'
  | 'never-replaced'
  | 'prepared'
  | 'preparing'
  | 'replaced'
  | 'rollback-failed'
  | 'rollback-postverify-failed'
  | 'rolled-back';

interface TransactionItem {
  backupIdentity?: PreparedFileIdentity;
  backupPath: string;
  nextIdentity?: PreparedFileIdentity;
  nextPath: string;
  rollbackIdentity?: PreparedFileIdentity;
  rollbackPath: string;
  snapshot: ModifiedTargetSnapshot;
  state: TransactionItemState;
  transactionDirectory: string;
}

export interface MigrationTransactionOptions {
  afterPrepareItem?: (
    item: MigrationWritePlanItem,
    index: number,
  ) => Promise<void>;
  makeTransactionDirectory?: (prefix: string) => Promise<string>;
  openFile?: (
    filePath: string,
    flags: 'r+' | 'wx',
    mode?: number,
  ) => Promise<FileHandle>;
  readFileBytes?: (filePath: string) => Promise<Buffer>;
  removePath?: (filePath: string) => Promise<void>;
  replace?: (sourcePath: string, targetPath: string) => Promise<void>;
  retryDelaysMs?: readonly number[];
}

export class MigrationTransactionError extends Error {
  override readonly name = 'MigrationTransactionError';
  readonly cleanupFailures: Error[];
  readonly primaryFailure: unknown;
  readonly rollbackFailures: Error[];

  constructor(options: {
    cleanupFailures: Error[];
    primaryFailure: unknown;
    rollbackFailures?: Error[];
  }) {
    const primaryMessage = formatUnknownError(options.primaryFailure);
    const rollbackFailures = options.rollbackFailures ?? [];
    super(
      [
        `Migration transaction failed: ${primaryMessage}`,
        ...rollbackFailures.map(
          (failure) => `Rollback failure: ${failure.message}`,
        ),
        ...options.cleanupFailures.map(
          (failure) => `Cleanup failure: ${failure.message}`,
        ),
      ].join('\n'),
      { cause: options.primaryFailure },
    );
    this.primaryFailure = options.primaryFailure;
    this.rollbackFailures = rollbackFailures;
    this.cleanupFailures = options.cleanupFailures;
  }
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasErrorCode(error: unknown): error is Error & { code: string } {
  return error instanceof Error && 'code' in error;
}

function normalizeTimestamp(raw: BigIntStats): OriginalTimestampSnapshot {
  const restorableMtimeMs = Number(raw.mtimeNs / nanosecondsPerMillisecond);

  if (!Number.isSafeInteger(restorableMtimeMs)) {
    throw new TerminalReplacementValidationError(
      `File mtime is outside the supported Date range: ${raw.mtimeNs}`,
    );
  }

  return {
    observedMtimeNs: raw.mtimeNs,
    restorableMtimeMs,
  };
}

function bigintToSafeNumber(value: bigint, label: string): number {
  const output = Number(value);

  if (!Number.isSafeInteger(output)) {
    throw new TerminalReplacementValidationError(
      `${label} is outside the supported integer range: ${value}`,
    );
  }

  return output;
}

function normalizeStat(raw: BigIntStats): NormalizedFileStat {
  const isPosix = process.platform !== 'win32';

  return {
    atimeMs: Number(raw.atimeNs / nanosecondsPerMillisecond),
    ...(isPosix
      ? {
          chownGid: bigintToSafeNumber(raw.gid, 'gid'),
          chownUid: bigintToSafeNumber(raw.uid, 'uid'),
          gid: raw.gid,
          uid: raw.uid,
        }
      : {}),
    dev: raw.dev,
    fileType: raw.isFile()
      ? 'regular'
      : raw.isDirectory()
        ? 'directory'
        : raw.isSymbolicLink()
          ? 'symlink'
          : 'other',
    ino: raw.ino,
    nlink: raw.nlink,
    permissionMode: Number(raw.mode & 0o7777n),
    rawMode: raw.mode,
    size: raw.size,
    timestamp: normalizeTimestamp(raw),
  };
}

function hashBytes(bytes: Uint8Array): FileContentIdentity {
  return {
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function createPreparedIdentity(
  bytes: Uint8Array,
  fileStat: NormalizedFileStat,
): PreparedFileIdentity {
  return {
    ...hashBytes(bytes),
    stat: fileStat,
  };
}

function assertEqual(
  actual: unknown,
  expected: unknown,
  label: string,
  filePath: string,
): void {
  if (actual !== expected) {
    throw new ReplacementDriftError(
      `${label} changed for ${filePath}: expected ${String(expected)}, received ${String(actual)}`,
    );
  }
}

function assertStatMatches(
  actual: NormalizedFileStat,
  expected: NormalizedFileStat,
  filePath: string,
  options: { compareObservedMtime: boolean; compareRestorableMtime: boolean },
): void {
  assertEqual(actual.dev, expected.dev, 'device', filePath);
  assertEqual(actual.ino, expected.ino, 'inode', filePath);
  assertEqual(actual.fileType, expected.fileType, 'file type', filePath);
  assertEqual(actual.nlink, expected.nlink, 'link count', filePath);
  assertEqual(actual.rawMode, expected.rawMode, 'mode', filePath);
  assertEqual(actual.uid, expected.uid, 'uid', filePath);
  assertEqual(actual.gid, expected.gid, 'gid', filePath);

  if (options.compareObservedMtime) {
    assertEqual(
      actual.timestamp.observedMtimeNs,
      expected.timestamp.observedMtimeNs,
      'observed mtime',
      filePath,
    );
  }

  if (options.compareRestorableMtime) {
    assertEqual(
      actual.timestamp.restorableMtimeMs,
      expected.timestamp.restorableMtimeMs,
      'restorable mtime',
      filePath,
    );
  }
}

function assertContentMatches(
  bytes: Uint8Array,
  expected: FileContentIdentity,
  filePath: string,
): void {
  const actual = hashBytes(bytes);

  assertEqual(actual.byteLength, expected.byteLength, 'byte length', filePath);
  assertEqual(actual.sha256, expected.sha256, 'content hash', filePath);
}

async function validationIo<T>(
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (hasErrorCode(error) && retryableAccessCodes.has(String(error.code))) {
      throw new RetryableReplacementValidationIoError(
        String(error.code) as 'EACCES' | 'EBUSY' | 'EPERM',
        `${label}: ${error.message}`,
        { cause: error },
      );
    }

    if (
      error instanceof ReplacementDriftError ||
      error instanceof RetryableReplacementValidationIoError ||
      error instanceof TerminalReplacementValidationError
    ) {
      throw error;
    }

    throw new TerminalReplacementValidationError(
      `${label}: ${formatUnknownError(error)}`,
      { cause: error },
    );
  }
}

async function assertWritable(
  filePath: string,
  openFile: NonNullable<MigrationTransactionOptions['openFile']>,
): Promise<void> {
  const handle = await validationIo(
    `Unable to open ${filePath} for writing`,
    () => openFile(filePath, 'r+'),
  );

  await validationIo(`Unable to close writable handle for ${filePath}`, () =>
    handle.close(),
  );
}

async function assertLogicalPathHasNoLinks(
  rootDir: string,
  targetPath: string,
): Promise<void> {
  const relativePath = path.relative(rootDir, targetPath);

  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new TerminalReplacementValidationError(
      `Migration target is outside the logical workspace root: ${targetPath}`,
    );
  }

  let currentPath = rootDir;

  for (const segment of relativePath.split(/[\\/]/u).filter(Boolean)) {
    const inspectedPath = path.join(currentPath, segment);
    currentPath = inspectedPath;
    const currentStat = normalizeStat(
      await validationIo(`Unable to inspect ${inspectedPath}`, () =>
        lstat(inspectedPath, { bigint: true }),
      ),
    );

    if (currentStat.fileType === 'symlink') {
      throw new TerminalReplacementValidationError(
        `Migration target path contains a symbolic link or junction: ${inspectedPath}`,
      );
    }
  }
}

async function collectModifiedSnapshot(
  rootDir: string,
  canonicalRootDir: string,
  item: MigrationWritePlanItem,
  options: Required<
    Pick<MigrationTransactionOptions, 'openFile' | 'readFileBytes'>
  >,
): Promise<ModifiedTargetSnapshot> {
  await assertLogicalPathHasNoLinks(rootDir, item.configPath);
  const canonicalPath = await validationIo(
    `Unable to resolve canonical target ${item.configPath}`,
    () => realpath(item.configPath),
  );

  if (!isPathInsideDirectory(canonicalPath, canonicalRootDir)) {
    throw new TerminalReplacementValidationError(
      `Migration target resolves outside the canonical workspace root: ${item.configPath} -> ${canonicalPath}`,
    );
  }

  const targetLstat = normalizeStat(
    await validationIo(`Unable to inspect target ${item.configPath}`, () =>
      lstat(item.configPath, { bigint: true }),
    ),
  );
  const targetStat = normalizeStat(
    await validationIo(`Unable to stat target ${item.configPath}`, () =>
      stat(item.configPath, { bigint: true }),
    ),
  );

  if (targetLstat.fileType !== 'regular' || targetStat.fileType !== 'regular') {
    throw new TerminalReplacementValidationError(
      `Migration only supports regular config files: ${item.configPath}`,
    );
  }

  if (targetStat.nlink !== 1n) {
    throw new TerminalReplacementValidationError(
      `Migration only supports single-link config files: ${item.configPath} has ${targetStat.nlink} links`,
    );
  }

  await assertWritable(item.configPath, options.openFile);
  const bytes = await validationIo(
    `Unable to read target ${item.configPath}`,
    () => options.readFileBytes(item.configPath),
  );

  if (!bytes.equals(item.originalBytes)) {
    throw new ReplacementDriftError(
      `Migration target changed since planning: ${item.configPath}`,
    );
  }

  return {
    ...createPreparedIdentity(bytes, targetStat),
    allowedCanonicalRootDir: normalizeAbsolutePath(canonicalRootDir),
    allowedRootDir: normalizeAbsolutePath(rootDir),
    canonicalPath: normalizeAbsolutePath(canonicalPath),
    item,
  };
}

async function validateCanonicalTarget(
  rootDir: string,
  canonicalRootDir: string,
  snapshot: ModifiedTargetSnapshot,
): Promise<void> {
  await assertLogicalPathHasNoLinks(rootDir, snapshot.item.configPath);
  const canonicalPath = await validationIo(
    `Unable to resolve canonical target ${snapshot.item.configPath}`,
    () => realpath(snapshot.item.configPath),
  );

  if (!isPathInsideDirectory(canonicalPath, canonicalRootDir)) {
    throw new ReplacementDriftError(
      `Migration target moved outside the canonical workspace root: ${snapshot.item.configPath}`,
    );
  }

  assertEqual(
    normalizeAbsolutePath(canonicalPath),
    snapshot.canonicalPath,
    'canonical path',
    snapshot.item.configPath,
  );
}

async function validateFile(
  filePath: string,
  expected: PreparedFileIdentity,
  options: Required<Pick<MigrationTransactionOptions, 'readFileBytes'>>,
  comparison: {
    compareObservedMtime: boolean;
    compareRestorableMtime: boolean;
  },
): Promise<void> {
  const currentStat = normalizeStat(
    await validationIo(`Unable to stat ${filePath}`, () =>
      stat(filePath, { bigint: true }),
    ),
  );
  const bytes = await validationIo(`Unable to read ${filePath}`, () =>
    options.readFileBytes(filePath),
  );

  assertStatMatches(currentStat, expected.stat, filePath, comparison);
  assertContentMatches(bytes, expected, filePath);
}

async function validateOriginalTarget(
  rootDir: string,
  canonicalRootDir: string,
  snapshot: ModifiedTargetSnapshot,
  options: Required<
    Pick<MigrationTransactionOptions, 'openFile' | 'readFileBytes'>
  >,
): Promise<void> {
  await validateCanonicalTarget(rootDir, canonicalRootDir, snapshot);
  await assertWritable(snapshot.item.configPath, options.openFile);
  await validateFile(snapshot.item.configPath, snapshot, options, {
    compareObservedMtime: true,
    compareRestorableMtime: true,
  });
}

async function applySupportedMetadata(
  handle: FileHandle,
  snapshot: ModifiedTargetSnapshot,
  restoreTimestamp: boolean,
): Promise<void> {
  if (
    process.platform !== 'win32' &&
    snapshot.stat.chownUid !== undefined &&
    snapshot.stat.chownGid !== undefined
  ) {
    await handle.chown(snapshot.stat.chownUid, snapshot.stat.chownGid);
  }

  await handle.chmod(snapshot.stat.permissionMode);

  if (restoreTimestamp) {
    const atimeSeconds = (snapshot.stat.atimeMs + 0.5) / 1000;
    const mtimeSeconds =
      (snapshot.stat.timestamp.restorableMtimeMs + 0.5) / 1000;

    await handle.utimes(atimeSeconds, mtimeSeconds);
  }
}

async function prepareFile(options: {
  bytes: Buffer;
  filePath: string;
  openFile: NonNullable<MigrationTransactionOptions['openFile']>;
  readFileBytes: NonNullable<MigrationTransactionOptions['readFileBytes']>;
  restoreTimestamp: boolean;
  snapshot: ModifiedTargetSnapshot;
  trackedHandles: Set<FileHandle>;
}): Promise<PreparedFileIdentity> {
  const handle = await options.openFile(options.filePath, 'wx', 0o600);
  options.trackedHandles.add(handle);

  try {
    await handle.writeFile(options.bytes);
    await applySupportedMetadata(
      handle,
      options.snapshot,
      options.restoreTimestamp,
    );
    await handle.sync();
    await handle.close();
    options.trackedHandles.delete(handle);
  } catch (error) {
    try {
      await handle.close();
    } catch {
      // Preserve the preparation failure as the primary error.
    }
    options.trackedHandles.delete(handle);
    throw error;
  }

  const preparedStat = normalizeStat(
    await stat(options.filePath, { bigint: true }),
  );
  const bytes = await options.readFileBytes(options.filePath);
  const identity = createPreparedIdentity(bytes, preparedStat);

  assertContentMatches(bytes, hashBytes(options.bytes), options.filePath);
  assertEqual(
    preparedStat.permissionMode,
    options.snapshot.stat.permissionMode,
    'permission mode',
    options.filePath,
  );
  assertEqual(
    preparedStat.uid,
    options.snapshot.stat.uid,
    'uid',
    options.filePath,
  );
  assertEqual(
    preparedStat.gid,
    options.snapshot.stat.gid,
    'gid',
    options.filePath,
  );

  if (options.restoreTimestamp) {
    assertEqual(
      preparedStat.timestamp.restorableMtimeMs,
      options.snapshot.stat.timestamp.restorableMtimeMs,
      'restorable mtime',
      options.filePath,
    );
  }

  return identity;
}

function assertUniquePhysicalTargets(
  snapshots: readonly ModifiedTargetSnapshot[],
): void {
  const pathsByIdentity = new Map<string, Set<string>>();

  for (const snapshot of snapshots) {
    for (const key of [
      `canonical\0${snapshot.canonicalPath}`,
      `inode\0${snapshot.stat.dev}\0${snapshot.stat.ino}`,
    ]) {
      const paths = pathsByIdentity.get(key) ?? new Set<string>();
      paths.add(snapshot.item.configPath);
      pathsByIdentity.set(key, paths);
    }
  }

  const conflicts = [
    ...new Map(
      [...pathsByIdentity.values()]
        .filter((paths) => paths.size > 1)
        .map((paths) => {
          const sortedPaths = [...paths].sort((left, right) =>
            left.localeCompare(right),
          );
          return [sortedPaths.join('\0'), sortedPaths] as const;
        }),
    ).values(),
  ];

  if (conflicts.length > 0) {
    throw new TerminalReplacementValidationError(
      [
        'Migration write plan contains multiple logical paths for the same physical file:',
        ...conflicts.flatMap((paths) => paths.map((value) => `  - ${value}`)),
      ].join('\n'),
    );
  }
}

async function closeTrackedHandles(
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
    } finally {
      handles.delete(handle);
    }
  }
}

async function cleanupTransactionArtifacts(options: {
  directories: readonly string[];
  failures: Error[];
  items: readonly TransactionItem[];
  protectedItems: ReadonlySet<TransactionItem>;
  removePath: NonNullable<MigrationTransactionOptions['removePath']>;
}): Promise<void> {
  for (const item of options.items) {
    if (options.protectedItems.has(item)) {
      continue;
    }

    for (const artifactPath of [
      item.nextPath,
      item.backupPath,
      item.rollbackPath,
    ]) {
      try {
        await options.removePath(artifactPath);
      } catch (error) {
        options.failures.push(
          new Error(
            `Unable to remove migration artifact ${artifactPath}: ${formatUnknownError(error)}`,
          ),
        );
      }
    }
  }

  for (const directory of [...new Set(options.directories)].toReversed()) {
    try {
      await rmdir(directory);
    } catch (error) {
      if (!hasErrorCode(error) || error.code !== 'ENOENT') {
        options.failures.push(
          new Error(
            `Unable to remove migration transaction directory ${directory}: ${formatUnknownError(error)}`,
          ),
        );
      }
    }
  }
}

async function verifyWithRetry(
  operation: () => Promise<void>,
  retryDelaysMs: readonly number[],
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      if (
        !(error instanceof RetryableReplacementValidationIoError) ||
        attempt >= retryDelaysMs.length
      ) {
        throw error;
      }

      await new Promise<void>((resolve) =>
        setTimeout(resolve, retryDelaysMs[attempt]!),
      );
    }
  }
}

async function rollbackItem(options: {
  item: TransactionItem;
  openFile: NonNullable<MigrationTransactionOptions['openFile']>;
  readFileBytes: NonNullable<MigrationTransactionOptions['readFileBytes']>;
  replace?: MigrationTransactionOptions['replace'];
  retryDelaysMs: readonly number[];
  trackedHandles: Set<FileHandle>;
}): Promise<void> {
  const item = options.item;

  if (!item.backupIdentity || !item.nextIdentity) {
    throw new Error(
      `Rollback identities are missing for ${item.snapshot.item.configPath}`,
    );
  }

  await validateFile(item.backupPath, item.backupIdentity, options, {
    compareObservedMtime: true,
    compareRestorableMtime: true,
  });
  item.rollbackIdentity = await prepareFile({
    bytes: item.snapshot.item.originalBytes,
    filePath: item.rollbackPath,
    openFile: options.openFile,
    readFileBytes: options.readFileBytes,
    restoreTimestamp: true,
    snapshot: item.snapshot,
    trackedHandles: options.trackedHandles,
  });

  await replaceFileWithRetry(item.rollbackPath, item.snapshot.item.configPath, {
    beforeAttempt: async () => {
      await validateCanonicalTarget(
        item.snapshot.allowedRootDir,
        item.snapshot.allowedCanonicalRootDir,
        item.snapshot,
      );
      await validateFile(
        item.snapshot.item.configPath,
        item.nextIdentity!,
        options,
        {
          compareObservedMtime: true,
          compareRestorableMtime: true,
        },
      );
      await validateFile(item.rollbackPath, item.rollbackIdentity!, options, {
        compareObservedMtime: true,
        compareRestorableMtime: true,
      });
      await validateFile(item.backupPath, item.backupIdentity!, options, {
        compareObservedMtime: true,
        compareRestorableMtime: true,
      });
    },
    replace: options.replace,
    retryDelaysMs: options.retryDelaysMs,
  });

  try {
    await verifyWithRetry(async () => {
      await validateCanonicalTarget(
        item.snapshot.allowedRootDir,
        item.snapshot.allowedCanonicalRootDir,
        item.snapshot,
      );
      const restoredStat = normalizeStat(
        await validationIo(
          `Unable to stat restored target ${item.snapshot.item.configPath}`,
          () => stat(item.snapshot.item.configPath, { bigint: true }),
        ),
      );
      const restoredBytes = await validationIo(
        `Unable to read restored target ${item.snapshot.item.configPath}`,
        () => options.readFileBytes(item.snapshot.item.configPath),
      );

      assertContentMatches(
        restoredBytes,
        item.snapshot,
        item.snapshot.item.configPath,
      );
      assertEqual(
        restoredStat.permissionMode,
        item.snapshot.stat.permissionMode,
        'permission mode',
        item.snapshot.item.configPath,
      );
      assertEqual(
        restoredStat.uid,
        item.snapshot.stat.uid,
        'uid',
        item.snapshot.item.configPath,
      );
      assertEqual(
        restoredStat.gid,
        item.snapshot.stat.gid,
        'gid',
        item.snapshot.item.configPath,
      );
      assertEqual(
        restoredStat.timestamp.restorableMtimeMs,
        item.snapshot.stat.timestamp.restorableMtimeMs,
        'restorable mtime',
        item.snapshot.item.configPath,
      );
    }, options.retryDelaysMs);
  } catch (error) {
    item.state = 'rollback-postverify-failed';
    throw error;
  }

  item.state = 'rolled-back';
}

function defaultRemovePath(filePath: string): Promise<void> {
  return rm(filePath, { force: true });
}

export async function executeMigrationWritePlan(
  allowedRootDirs: string | readonly string[],
  plan: readonly MigrationWritePlanItem[],
  transactionOptions: MigrationTransactionOptions = {},
): Promise<MigrationTransactionExecutionResult> {
  const modifiedItems = plan.filter((item) => item.status === 'modified');
  const skippedFiles = plan
    .filter((item) => item.status === 'skipped')
    .map((item) => item.configPath);

  if (modifiedItems.length === 0) {
    return {
      cleanupWarnings: [],
      modifiedFiles: [],
      skippedFiles,
    };
  }

  const options = {
    makeTransactionDirectory:
      transactionOptions.makeTransactionDirectory ?? mkdtemp,
    openFile: transactionOptions.openFile ?? open,
    readFileBytes: transactionOptions.readFileBytes ?? readFile,
    removePath: transactionOptions.removePath ?? defaultRemovePath,
    retryDelaysMs:
      transactionOptions.retryDelaysMs ?? verificationRetryDelaysMs,
  };
  const normalizedAllowedRootDirs = [
    ...new Set(
      (typeof allowedRootDirs === 'string'
        ? [allowedRootDirs]
        : allowedRootDirs
      ).map(normalizeAbsolutePath),
    ),
  ].sort((left, right) => right.length - left.length);
  if (normalizedAllowedRootDirs.length === 0) {
    throw new TerminalReplacementValidationError(
      'Migration requires at least one canonical allowed Git worktree root.',
    );
  }
  const allowedRoots = await Promise.all(
    normalizedAllowedRootDirs.map(async (rootDir) => ({
      canonicalRootDir: normalizeAbsolutePath(await realpath(rootDir)),
      rootDir,
    })),
  );
  const snapshots: ModifiedTargetSnapshot[] = [];

  for (const item of modifiedItems) {
    const allowedRoot = allowedRoots.find(
      (candidate) =>
        normalizeAbsolutePath(item.configPath) === candidate.rootDir ||
        isPathInsideDirectory(item.configPath, candidate.rootDir),
    );
    if (!allowedRoot) {
      throw new TerminalReplacementValidationError(
        `Migration target is outside every allowed Git worktree root: ${item.configPath}`,
      );
    }
    snapshots.push(
      await collectModifiedSnapshot(
        allowedRoot.rootDir,
        allowedRoot.canonicalRootDir,
        item,
        options,
      ),
    );
  }

  assertUniquePhysicalTargets(snapshots);

  const directoriesByParent = new Map<string, string>();
  const transactionItems: TransactionItem[] = [];
  const trackedHandles = new Set<FileHandle>();
  const createdDirectories: string[] = [];

  try {
    for (const [index, snapshot] of snapshots.entries()) {
      const parentDirectory = path.dirname(snapshot.item.configPath);
      let transactionDirectory = directoriesByParent.get(parentDirectory);

      if (!transactionDirectory) {
        transactionDirectory = await options.makeTransactionDirectory(
          path.join(parentDirectory, '.limina-migration-'),
        );
        createdDirectories.push(transactionDirectory);
        directoriesByParent.set(parentDirectory, transactionDirectory);

        if (process.platform !== 'win32') {
          await chmod(transactionDirectory, 0o700);
          const directoryStat = normalizeStat(
            await stat(transactionDirectory, { bigint: true }),
          );
          assertEqual(
            directoryStat.permissionMode,
            0o700,
            'transaction directory mode',
            transactionDirectory,
          );
        }
      }

      const item: TransactionItem = {
        backupPath: path.join(transactionDirectory, `${index}.backup`),
        nextPath: path.join(transactionDirectory, `${index}.next`),
        rollbackPath: path.join(transactionDirectory, `${index}.rollback`),
        snapshot,
        state: 'preparing',
        transactionDirectory,
      };
      transactionItems.push(item);
      item.nextIdentity = await prepareFile({
        bytes: Buffer.from(snapshot.item.nextContent),
        filePath: item.nextPath,
        openFile: options.openFile,
        readFileBytes: options.readFileBytes,
        restoreTimestamp: false,
        snapshot,
        trackedHandles,
      });
      item.backupIdentity = await prepareFile({
        bytes: snapshot.item.originalBytes,
        filePath: item.backupPath,
        openFile: options.openFile,
        readFileBytes: options.readFileBytes,
        restoreTimestamp: true,
        snapshot,
        trackedHandles,
      });
      item.state = 'prepared';
      await transactionOptions.afterPrepareItem?.(snapshot.item, index);
    }
  } catch (error) {
    const cleanupFailures: Error[] = [];
    await closeTrackedHandles(trackedHandles, cleanupFailures);
    await cleanupTransactionArtifacts({
      directories: createdDirectories,
      failures: cleanupFailures,
      items: transactionItems,
      protectedItems: new Set(),
      removePath: options.removePath,
    });
    throw new MigrationTransactionError({
      cleanupFailures,
      primaryFailure: error,
    });
  }

  try {
    for (const item of transactionItems) {
      await replaceFileWithRetry(item.nextPath, item.snapshot.item.configPath, {
        beforeAttempt: async () => {
          await validateOriginalTarget(
            item.snapshot.allowedRootDir,
            item.snapshot.allowedCanonicalRootDir,
            item.snapshot,
            options,
          );
          await validateFile(item.nextPath, item.nextIdentity!, options, {
            compareObservedMtime: true,
            compareRestorableMtime: true,
          });
        },
        replace: transactionOptions.replace ?? rename,
        retryDelaysMs: options.retryDelaysMs,
      });
      item.state = 'replaced';
    }
  } catch (error) {
    const rollbackFailures: Error[] = [];

    for (const item of transactionItems.toReversed()) {
      if (item.state !== 'replaced') {
        item.state = 'never-replaced';
        continue;
      }

      try {
        await rollbackItem({
          item,
          openFile: options.openFile,
          readFileBytes: options.readFileBytes,
          replace: transactionOptions.replace,
          retryDelaysMs: options.retryDelaysMs,
          trackedHandles,
        });
      } catch (error) {
        const rollbackState = item.state as TransactionItemState;

        if (rollbackState !== 'rollback-postverify-failed') {
          item.state = 'rollback-failed';
        }
        rollbackFailures.push(
          new Error(
            `Unable to roll back ${item.snapshot.item.configPath}; recovery backup retained at ${item.backupPath}: ${formatUnknownError(error)}`,
            { cause: error },
          ),
        );
      }
    }

    const cleanupFailures: Error[] = [];
    await closeTrackedHandles(trackedHandles, cleanupFailures);
    const protectedItems = new Set(
      transactionItems.filter(
        (item) =>
          item.state === 'rollback-failed' ||
          item.state === 'rollback-postverify-failed',
      ),
    );
    await cleanupTransactionArtifacts({
      directories: createdDirectories,
      failures: cleanupFailures,
      items: transactionItems,
      protectedItems,
      removePath: options.removePath,
    });
    throw new MigrationTransactionError({
      cleanupFailures,
      primaryFailure: error,
      rollbackFailures,
    });
  }

  for (const item of transactionItems) {
    item.state = 'committed';
  }

  const cleanupFailures: Error[] = [];
  await cleanupTransactionArtifacts({
    directories: createdDirectories,
    failures: cleanupFailures,
    items: transactionItems,
    protectedItems: new Set(),
    removePath: options.removePath,
  });

  return {
    cleanupWarnings: cleanupFailures.map((failure) => ({
      message: failure.message,
      path:
        transactionItems.find((item) =>
          failure.message.includes(item.transactionDirectory),
        )?.transactionDirectory ?? normalizedAllowedRootDirs[0]!,
    })),
    modifiedFiles: modifiedItems.map((item) => item.configPath),
    skippedFiles,
  };
}
