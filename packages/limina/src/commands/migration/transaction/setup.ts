import { isPathInsideDirectory, normalizeAbsolutePath } from '#utils/path';
import { mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises';
import { TerminalReplacementValidationError } from '../../../check-reporting/atomic-writer';
import { collectModifiedSnapshot } from './file-validation';
import type {
  MigrationTransactionExecutionResult,
  MigrationTransactionOptions,
  MigrationWritePlanItem,
  ModifiedTargetSnapshot,
  TransactionRuntimeOptions,
} from './types';

const verificationRetryDelaysMs = [10, 25, 50, 100] as const;

export interface AllowedRoot {
  canonicalRootDir: string;
  rootDir: string;
}

export function defaultRemovePath(filePath: string): Promise<void> {
  return rm(filePath, { force: true });
}

function withDefault<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

export function resolveTransactionRuntimeOptions(
  options: MigrationTransactionOptions,
): TransactionRuntimeOptions {
  return {
    makeTransactionDirectory: withDefault(
      options.makeTransactionDirectory,
      mkdtemp,
    ),
    openFile: withDefault(options.openFile, open),
    readFileBytes: withDefault(options.readFileBytes, readFile),
    removePath: withDefault(options.removePath, defaultRemovePath),
    retryDelaysMs: withDefault(
      options.retryDelaysMs,
      verificationRetryDelaysMs,
    ),
  };
}

function normalizeAllowedRootDirs(
  allowedRootDirs: string | readonly string[],
): string[] {
  const roots =
    typeof allowedRootDirs === 'string' ? [allowedRootDirs] : allowedRootDirs;
  return [...new Set(roots.map(normalizeAbsolutePath))].sort(
    (left, right) => right.length - left.length,
  );
}

export async function resolveAllowedRoots(
  allowedRootDirs: string | readonly string[],
): Promise<{ normalizedRootDirs: string[]; roots: AllowedRoot[] }> {
  const normalizedRootDirs = normalizeAllowedRootDirs(allowedRootDirs);
  if (normalizedRootDirs.length === 0) {
    throw new TerminalReplacementValidationError(
      'Migration requires at least one canonical allowed Git worktree root.',
    );
  }
  const roots = await Promise.all(
    normalizedRootDirs.map(async (rootDir) => ({
      canonicalRootDir: normalizeAbsolutePath(await realpath(rootDir)),
      rootDir,
    })),
  );
  return { normalizedRootDirs, roots };
}

function findAllowedRoot(
  configPath: string,
  allowedRoots: readonly AllowedRoot[],
): AllowedRoot | undefined {
  const normalizedPath = normalizeAbsolutePath(configPath);
  return allowedRoots.find((candidate) => {
    if (normalizedPath === candidate.rootDir) return true;
    return isPathInsideDirectory(normalizedPath, candidate.rootDir);
  });
}

async function collectItemSnapshot(options: {
  allowedRoots: readonly AllowedRoot[];
  item: MigrationWritePlanItem;
  runtime: TransactionRuntimeOptions;
}): Promise<ModifiedTargetSnapshot> {
  const allowedRoot = findAllowedRoot(
    options.item.configPath,
    options.allowedRoots,
  );
  if (allowedRoot === undefined) {
    throw new TerminalReplacementValidationError(
      `Migration target is outside every allowed Git worktree root: ${options.item.configPath}`,
    );
  }
  return collectModifiedSnapshot({
    canonicalRootDir: allowedRoot.canonicalRootDir,
    item: options.item,
    rootDir: allowedRoot.rootDir,
    validation: options.runtime,
  });
}

export async function collectModifiedSnapshots(options: {
  allowedRoots: readonly AllowedRoot[];
  items: readonly MigrationWritePlanItem[];
  runtime: TransactionRuntimeOptions;
}): Promise<ModifiedTargetSnapshot[]> {
  const snapshots: ModifiedTargetSnapshot[] = [];
  for (const item of options.items) {
    snapshots.push(await collectItemSnapshot({ ...options, item }));
  }
  return snapshots;
}

export function partitionMigrationPlan(
  plan: readonly MigrationWritePlanItem[],
): { modifiedItems: MigrationWritePlanItem[]; skippedFiles: string[] } {
  return {
    modifiedItems: plan.filter((item) => item.status === 'modified'),
    skippedFiles: plan
      .filter((item) => item.status === 'skipped')
      .map((item) => item.configPath),
  };
}

export function createEmptyMigrationResult(
  skippedFiles: string[],
): MigrationTransactionExecutionResult {
  return { cleanupWarnings: [], modifiedFiles: [], skippedFiles };
}
