import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'pathe';
import {
  isNonEmptyString,
  isPositiveInteger,
  isString,
  matchesRecordSchema,
} from '../validation/record-schema';
import {
  CrossProcessLeaseCorruptError,
  type CrossProcessLeaseOwner,
} from './cross-process-lease-types';

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export async function holderExists(holderPath: string): Promise<boolean> {
  return (await readPresentOwner(holderPath)) !== null;
}

interface HolderRecord {
  fileName: string;
  owner: CrossProcessLeaseOwner;
}

function ownerFileName(owner: CrossProcessLeaseOwner): string {
  return `owner-${encodeURIComponent(owner.token)}.json`;
}

export function createLeaseOwner(): CrossProcessLeaseOwner {
  return {
    hostname: hostname(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: randomUUID(),
  };
}

function isOwner(value: unknown): value is CrossProcessLeaseOwner {
  return matchesRecordSchema(value, {
    hostname: isString,
    pid: isPositiveInteger,
    startedAt: isString,
    token: isNonEmptyString,
  });
}

function throwOwnerReadError(error: unknown, holderPath: string): never {
  if (hasCode(error, 'ENOENT')) throw error;
  throw new CrossProcessLeaseCorruptError(
    `Cross-process lease owner is corrupt at ${holderPath}: ${String(error)}`,
  );
}

async function readOwner(holderPath: string): Promise<HolderRecord | null> {
  try {
    const names = await readdir(holderPath);
    if (names.length === 0) return null;
    return await readOwnerRecord(holderPath, names);
  } catch (error) {
    return throwOwnerReadError(error, holderPath);
  }
}

async function readOwnerRecord(
  holderPath: string,
  names: string[],
): Promise<HolderRecord> {
  if (names.length !== 1) throw new Error('ambiguous owner record');
  const fileName = names[0]!;
  const value: unknown = JSON.parse(
    await readFile(path.join(holderPath, fileName), 'utf8'),
  );
  if (!isOwner(value)) throw new Error('invalid owner shape');
  assertOwnerFileName(fileName, value);
  return { fileName, owner: value };
}

function assertOwnerFileName(
  fileName: string,
  owner: CrossProcessLeaseOwner,
): void {
  // Legacy records can be retired, but are never published by this protocol.
  if (fileName === 'owner.json') return;
  if (fileName === ownerFileName(owner)) return;
  throw new Error('owner token does not match its record path');
}

function localProcessSignalResult(error: unknown): boolean {
  if (hasCode(error, 'ESRCH')) return false;
  if (hasCode(error, 'EPERM')) return true;
  throw error;
}

function isLocalProcessAlive(owner: CrossProcessLeaseOwner): boolean | null {
  if (owner.hostname !== hostname()) return null;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return localProcessSignalResult(error);
  }
}

async function readPresentOwner(
  holderPath: string,
): Promise<HolderRecord | null> {
  try {
    return await readOwner(holderPath);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  }
}

export async function removeDeadHolder(holderPath: string): Promise<boolean> {
  const record = await readPresentOwner(holderPath);
  if (record === null) return removeEmptyHolder(holderPath);
  if (isLocalProcessAlive(record.owner) !== false) return false;
  return removeHolderRecord(holderPath, record.fileName);
}

const retryableHolderPublicationCodes = new Set(['EACCES', 'EBUSY', 'EPERM']);

function isRetryableHolderPublicationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    retryableHolderPublicationCodes.has(String(error.code))
  );
}

function isDefiniteHolderCollision(error: unknown): boolean {
  // These errors already prove that rename collided with another holder.
  // That holder may finish before the follow-up read, so its continued
  // existence cannot be required to retry the acquisition.
  return hasCode(error, 'EEXIST') || hasCode(error, 'ENOTEMPTY');
}

async function isHolderCollision(
  error: unknown,
  holderPath: string,
): Promise<boolean> {
  if (isDefiniteHolderCollision(error)) return true;
  if (!isRetryableHolderPublicationError(error)) return false;
  return holderExists(holderPath);
}

export async function publishHolder(options: {
  holderPath: string;
  owner: CrossProcessLeaseOwner;
  rootPath: string;
}): Promise<boolean> {
  const candidatePath = path.join(
    options.rootPath,
    `.candidate-${options.owner.token}`,
  );
  await mkdir(candidatePath, { recursive: false });
  try {
    await writeFile(
      path.join(candidatePath, ownerFileName(options.owner)),
      `${JSON.stringify(options.owner, null, 2)}\n`,
      { flag: 'wx' },
    );
    await rename(candidatePath, options.holderPath);
    return true;
  } catch (error) {
    await rm(candidatePath, { force: true, recursive: true });
    if (await isHolderCollision(error, options.holderPath)) return false;
    throw error;
  }
}

export async function releaseOwnedHolder(
  holderPath: string,
  owner: CrossProcessLeaseOwner,
): Promise<void> {
  const current = await readOwner(holderPath);
  if (current?.owner.token !== owner.token) {
    throw new CrossProcessLeaseCorruptError(
      `Cross-process lease ownership changed before release: ${holderPath}.`,
    );
  }
  await removeHolderRecord(holderPath, current.fileName);
}

async function removeHolderRecord(
  holderPath: string,
  fileName: string,
): Promise<boolean> {
  try {
    await unlink(path.join(holderPath, fileName));
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
  return removeEmptyHolder(holderPath);
}

async function removeEmptyHolder(holderPath: string): Promise<boolean> {
  // Another publisher may have replaced the empty slot. Never recursively
  // remove it: the new holder's token record makes rmdir fail harmlessly.
  try {
    await rmdir(holderPath);
    return true;
  } catch (error) {
    return handleHolderRemovalError(error);
  }
}

function handleHolderRemovalError(error: unknown): boolean {
  if (hasCode(error, 'ENOENT')) return true;
  if (isNonEmptyHolderError(error)) return false;
  throw error;
}

function isNonEmptyHolderError(error: unknown): boolean {
  return hasCode(error, 'ENOTEMPTY') || hasCode(error, 'EEXIST');
}
