import { mkdir, readdir } from 'node:fs/promises';
import path from 'pathe';
import {
  createLeaseOwner,
  holderExists,
  publishHolder,
  releaseOwnedHolder,
  removeDeadHolder,
} from './cross-process-lease-holder';
import {
  type CrossProcessLease,
  type CrossProcessLeaseOptions,
  type CrossProcessLeaseOwner,
  CrossProcessLeaseTimeoutError,
} from './cross-process-lease-types';

export {
  CrossProcessLeaseCorruptError,
  CrossProcessLeaseTimeoutError,
} from './cross-process-lease-types';
export type {
  CrossProcessLease,
  CrossProcessLeaseOptions,
  CrossProcessLeaseOwner,
} from './cross-process-lease-types';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_MS = 250;

function timeoutAt(options: CrossProcessLeaseOptions): number {
  return Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

async function waitForRetry(
  deadline: number,
  attempt: number,
  description: string,
): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new CrossProcessLeaseTimeoutError(
      `Timed out after 30 seconds waiting for ${description}.`,
    );
  }
  const delay = Math.min(MAX_BACKOFF_MS, 10 * 2 ** Math.min(attempt, 5));
  await new Promise((resolve) =>
    setTimeout(resolve, Math.min(delay, remaining)),
  );
}

function getLeasePaths(
  canonicalRootDir: string,
  options: CrossProcessLeaseOptions,
) {
  const rootPath = path.join(
    canonicalRootDir,
    '.state',
    'leases',
    options.leaseName ?? 'generated-artifacts',
  );
  return {
    readersPath: path.join(rootPath, 'readers'),
    rootPath,
    writerPath: path.join(rootPath, 'writer'),
  };
}

async function ensureLeaseDirectories(paths: ReturnType<typeof getLeasePaths>) {
  await mkdir(paths.readersPath, { recursive: true });
}

async function writerIsAbsent(writerPath: string): Promise<boolean> {
  if (!(await holderExists(writerPath))) return true;
  return removeDeadHolder(writerPath);
}

async function listReaderPaths(readersPath: string): Promise<string[]> {
  return (await readdir(readersPath, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(readersPath, entry.name));
}

async function activeReadersAreAbsent(readersPath: string): Promise<boolean> {
  const readers = await listReaderPaths(readersPath);
  for (const readerPath of readers) {
    if (!(await removeDeadHolder(readerPath))) return false;
  }
  return (await listReaderPaths(readersPath)).length === 0;
}

function createLease(options: {
  holderPath: string;
  owner: CrossProcessLeaseOwner;
  type: CrossProcessLease['type'];
}): CrossProcessLease {
  return {
    owner: options.owner,
    release: () => releaseOwnedHolder(options.holderPath, options.owner),
    type: options.type,
  };
}

async function validatePublishedReader(options: {
  holderPath: string;
  owner: CrossProcessLeaseOwner;
  writerPath: string;
}): Promise<CrossProcessLease | null> {
  if (await writerIsAbsent(options.writerPath)) {
    return createLease({ ...options, type: 'reader' });
  }
  await releaseOwnedHolder(options.holderPath, options.owner);
  return null;
}

async function tryAcquireReader(options: {
  owner: CrossProcessLeaseOwner;
  paths: ReturnType<typeof getLeasePaths>;
}): Promise<CrossProcessLease | null> {
  if (!(await writerIsAbsent(options.paths.writerPath))) return null;
  const holderPath = path.join(options.paths.readersPath, options.owner.token);
  const published = await publishHolder({
    holderPath,
    owner: options.owner,
    rootPath: options.paths.readersPath,
  });
  if (!published) return null;
  return validatePublishedReader({
    holderPath,
    owner: options.owner,
    writerPath: options.paths.writerPath,
  });
}

async function tryAcquireWriter(options: {
  owner: CrossProcessLeaseOwner;
  paths: ReturnType<typeof getLeasePaths>;
}): Promise<CrossProcessLease | null> {
  if (!(await writerIsAbsent(options.paths.writerPath))) return null;
  const published = await publishHolder({
    holderPath: options.paths.writerPath,
    owner: options.owner,
    rootPath: options.paths.rootPath,
  });
  if (!published) return null;
  return createLease({
    holderPath: options.paths.writerPath,
    owner: options.owner,
    type: 'writer',
  });
}

function leaseDescription(
  options: CrossProcessLeaseOptions,
  operation: string,
): string {
  return `${options.leaseName ?? 'generated-artifact'} ${operation}`;
}

async function retryLease(options: {
  acquire(): Promise<CrossProcessLease | null>;
  deadline: number;
  description: string;
}): Promise<CrossProcessLease> {
  for (let attempt = 0; ; attempt += 1) {
    const lease = await options.acquire();
    if (lease !== null) return lease;
    await waitForRetry(options.deadline, attempt, options.description);
  }
}

async function waitForActiveReaders(
  readersPath: string,
  deadline: number,
  description: string,
): Promise<void> {
  let attempt = 0;
  while (!(await activeReadersAreAbsent(readersPath))) {
    await waitForRetry(deadline, attempt, description);
    attempt += 1;
  }
}

export async function acquireCrossProcessReadLease(
  canonicalRootDir: string,
  options: CrossProcessLeaseOptions = {},
): Promise<CrossProcessLease> {
  const paths = getLeasePaths(canonicalRootDir, options);
  await ensureLeaseDirectories(paths);
  const owner = createLeaseOwner();
  const deadline = timeoutAt(options);
  return retryLease({
    acquire: () => tryAcquireReader({ owner, paths }),
    deadline,
    description: leaseDescription(options, 'read lease'),
  });
}

export async function acquireCrossProcessWriteLease(
  canonicalRootDir: string,
  options: CrossProcessLeaseOptions = {},
): Promise<CrossProcessLease> {
  const paths = getLeasePaths(canonicalRootDir, options);
  await ensureLeaseDirectories(paths);
  const owner = createLeaseOwner();
  const deadline = timeoutAt(options);
  const lease = await retryLease({
    acquire: () => tryAcquireWriter({ owner, paths }),
    deadline,
    description: leaseDescription(options, 'write lease'),
  });
  try {
    await waitForActiveReaders(
      paths.readersPath,
      deadline,
      leaseDescription(options, 'readers to exit'),
    );
    return lease;
  } catch (error) {
    await lease.release();
    throw error;
  }
}
