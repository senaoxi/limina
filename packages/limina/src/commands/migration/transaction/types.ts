import type { FileHandle } from 'node:fs/promises';

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

export interface NormalizedFileStat {
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

export interface FileContentIdentity {
  byteLength: number;
  sha256: string;
}

export interface PreparedFileIdentity extends FileContentIdentity {
  stat: NormalizedFileStat;
}

export interface ModifiedTargetSnapshot extends PreparedFileIdentity {
  allowedCanonicalRootDir: string;
  allowedRootDir: string;
  canonicalPath: string;
  item: MigrationWritePlanItem;
}

export type TransactionItemState =
  | 'committed'
  | 'never-replaced'
  | 'prepared'
  | 'preparing'
  | 'replaced'
  | 'rollback-failed'
  | 'rollback-postverify-failed'
  | 'rolled-back';

export interface TransactionItem {
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

export interface TransactionRuntimeOptions {
  makeTransactionDirectory: NonNullable<
    MigrationTransactionOptions['makeTransactionDirectory']
  >;
  openFile: NonNullable<MigrationTransactionOptions['openFile']>;
  readFileBytes: NonNullable<MigrationTransactionOptions['readFileBytes']>;
  removePath: NonNullable<MigrationTransactionOptions['removePath']>;
  retryDelaysMs: readonly number[];
}

export interface FileValidationOptions {
  readFileBytes: NonNullable<MigrationTransactionOptions['readFileBytes']>;
}

export interface OriginalTargetValidationOptions extends FileValidationOptions {
  openFile: NonNullable<MigrationTransactionOptions['openFile']>;
}

export interface StatComparisonOptions {
  compareObservedMtime: boolean;
  compareRestorableMtime: boolean;
}
