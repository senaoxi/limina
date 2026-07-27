import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import {
  ReplacementDriftError,
  RetryableReplacementValidationIoError,
  TerminalReplacementValidationError,
} from '../../../check-reporting/atomic-writer';
import { formatUnknownError, hasErrorCode } from './error';
import type {
  FileContentIdentity,
  NormalizedFileStat,
  OriginalTimestampSnapshot,
  PreparedFileIdentity,
  StatComparisonOptions,
} from './types';

const retryableAccessCodes = new Set(['EACCES', 'EBUSY', 'EPERM']);
const nanosecondsPerMillisecond = 1_000_000n;

function normalizeTimestamp(raw: BigIntStats): OriginalTimestampSnapshot {
  const restorableMtimeMs = Number(raw.mtimeNs / nanosecondsPerMillisecond);
  if (!Number.isSafeInteger(restorableMtimeMs)) {
    throw new TerminalReplacementValidationError(
      `File mtime is outside the supported Date range: ${raw.mtimeNs}`,
    );
  }
  return { observedMtimeNs: raw.mtimeNs, restorableMtimeMs };
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

function getFileType(raw: BigIntStats): NormalizedFileStat['fileType'] {
  const match = [
    { kind: 'regular' as const, matches: raw.isFile() },
    { kind: 'directory' as const, matches: raw.isDirectory() },
    { kind: 'symlink' as const, matches: raw.isSymbolicLink() },
  ].find((entry) => entry.matches);
  return match?.kind ?? 'other';
}

function getOwnership(raw: BigIntStats): Partial<NormalizedFileStat> {
  if (process.platform === 'win32') return {};
  return {
    chownGid: bigintToSafeNumber(raw.gid, 'gid'),
    chownUid: bigintToSafeNumber(raw.uid, 'uid'),
    gid: raw.gid,
    uid: raw.uid,
  };
}

export function normalizeStat(raw: BigIntStats): NormalizedFileStat {
  return {
    atimeMs: Number(raw.atimeNs / nanosecondsPerMillisecond),
    ...getOwnership(raw),
    dev: raw.dev,
    fileType: getFileType(raw),
    ino: raw.ino,
    nlink: raw.nlink,
    permissionMode: Number(raw.mode & 0o7777n),
    rawMode: raw.mode,
    size: raw.size,
    timestamp: normalizeTimestamp(raw),
  };
}

export function hashBytes(bytes: Uint8Array): FileContentIdentity {
  return {
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function createPreparedIdentity(
  bytes: Uint8Array,
  fileStat: NormalizedFileStat,
): PreparedFileIdentity {
  return { ...hashBytes(bytes), stat: fileStat };
}

export function assertEqual(options: {
  actual: unknown;
  expected: unknown;
  filePath: string;
  label: string;
}): void {
  if (options.actual === options.expected) return;
  throw new ReplacementDriftError(
    `${options.label} changed for ${options.filePath}: expected ${String(options.expected)}, received ${String(options.actual)}`,
  );
}

function assertBaseStatMatches(options: {
  actual: NormalizedFileStat;
  expected: NormalizedFileStat;
  filePath: string;
}): void {
  const fields: readonly [keyof NormalizedFileStat, string][] = [
    ['dev', 'device'],
    ['ino', 'inode'],
    ['fileType', 'file type'],
    ['nlink', 'link count'],
    ['rawMode', 'mode'],
    ['uid', 'uid'],
    ['gid', 'gid'],
  ];
  for (const [field, label] of fields) {
    assertEqual({
      actual: options.actual[field],
      expected: options.expected[field],
      filePath: options.filePath,
      label,
    });
  }
}

export function assertStatMatches(options: {
  actual: NormalizedFileStat;
  comparison: StatComparisonOptions;
  expected: NormalizedFileStat;
  filePath: string;
}): void {
  assertBaseStatMatches(options);
  if (options.comparison.compareObservedMtime) {
    assertEqual({
      actual: options.actual.timestamp.observedMtimeNs,
      expected: options.expected.timestamp.observedMtimeNs,
      filePath: options.filePath,
      label: 'observed mtime',
    });
  }
  if (options.comparison.compareRestorableMtime) {
    assertEqual({
      actual: options.actual.timestamp.restorableMtimeMs,
      expected: options.expected.timestamp.restorableMtimeMs,
      filePath: options.filePath,
      label: 'restorable mtime',
    });
  }
}

export function assertContentMatches(options: {
  bytes: Uint8Array;
  expected: FileContentIdentity;
  filePath: string;
}): void {
  const actual = hashBytes(options.bytes);
  assertEqual({
    actual: actual.byteLength,
    expected: options.expected.byteLength,
    filePath: options.filePath,
    label: 'byte length',
  });
  assertEqual({
    actual: actual.sha256,
    expected: options.expected.sha256,
    filePath: options.filePath,
    label: 'content hash',
  });
}

function isKnownValidationError(error: unknown): boolean {
  return [
    ReplacementDriftError,
    RetryableReplacementValidationIoError,
    TerminalReplacementValidationError,
  ].some((ErrorType) => error instanceof ErrorType);
}

function isRetryableAccessError(error: unknown): boolean {
  if (!hasErrorCode(error)) return false;
  return retryableAccessCodes.has(String(error.code));
}

function rethrowValidationError(error: unknown, label: string): never {
  if (isRetryableAccessError(error)) {
    const retryableError = error as Error & { code: string };
    throw new RetryableReplacementValidationIoError(
      retryableError.code as 'EACCES' | 'EBUSY' | 'EPERM',
      `${label}: ${retryableError.message}`,
      { cause: error },
    );
  }
  if (isKnownValidationError(error)) throw error;
  throw new TerminalReplacementValidationError(
    `${label}: ${formatUnknownError(error)}`,
    { cause: error },
  );
}

export async function validationIo<T>(
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    return rethrowValidationError(error, label);
  }
}
