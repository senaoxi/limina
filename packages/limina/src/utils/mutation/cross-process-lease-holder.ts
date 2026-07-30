import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
  try {
    await readFile(path.join(holderPath, 'owner.json'), 'utf8');
    return true;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false;
    throw error;
  }
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

async function readOwner(holderPath: string): Promise<CrossProcessLeaseOwner> {
  try {
    const value: unknown = JSON.parse(
      await readFile(path.join(holderPath, 'owner.json'), 'utf8'),
    );
    if (!isOwner(value)) throw new Error('invalid owner shape');
    return value;
  } catch (error) {
    return throwOwnerReadError(error, holderPath);
  }
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
): Promise<CrossProcessLeaseOwner | null> {
  try {
    return await readOwner(holderPath);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  }
}

export async function removeDeadHolder(holderPath: string): Promise<boolean> {
  const owner = await readPresentOwner(holderPath);
  if (owner === null) return true;
  if (isLocalProcessAlive(owner) !== false) return false;
  await rm(holderPath, { force: true, recursive: true });
  return true;
}

function isHolderCollision(error: unknown): boolean {
  return hasCode(error, 'EEXIST') || hasCode(error, 'ENOTEMPTY');
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
      path.join(candidatePath, 'owner.json'),
      `${JSON.stringify(options.owner, null, 2)}\n`,
      { flag: 'wx' },
    );
    await rename(candidatePath, options.holderPath);
    return true;
  } catch (error) {
    await rm(candidatePath, { force: true, recursive: true });
    if (isHolderCollision(error)) return false;
    throw error;
  }
}

export async function releaseOwnedHolder(
  holderPath: string,
  owner: CrossProcessLeaseOwner,
): Promise<void> {
  const current = await readOwner(holderPath);
  if (current.token !== owner.token) {
    throw new CrossProcessLeaseCorruptError(
      `Cross-process lease ownership changed before release: ${holderPath}.`,
    );
  }
  await rm(holderPath, { force: false, recursive: true });
}
