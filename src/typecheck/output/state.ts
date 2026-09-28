import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import type { RegularFileState } from './types';

export function isMissingError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (!('code' in error)) return false;
  return String(error.code) === 'ENOENT';
}

export function fileIdentityKey(state: RegularFileState): string {
  return JSON.stringify({
    dev: state.dev,
    hash: state.hash,
    ino: state.ino,
    length: state.length,
    mode: state.mode,
    nlink: state.nlink,
  });
}

function createFileState(
  stats: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
  content: Buffer,
): RegularFileState {
  return {
    content,
    dev: String(stats.dev),
    hash: createHash('sha256').update(content).digest('hex'),
    ino: String(stats.ino),
    length: content.byteLength,
    mode: Number(stats.mode) & 0o7777,
    nlink: Number(stats.nlink),
  };
}

function hasSameIdentity(
  left: { dev: bigint | number; ino: bigint | number },
  right: { dev: bigint | number; ino: bigint | number },
): boolean {
  if (String(left.dev) !== String(right.dev)) return false;
  return String(left.ino) === String(right.ino);
}

function hasStableFileState(
  before: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
  after: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
): boolean {
  if (!hasSameIdentity(before, after)) return false;
  if (Number(before.nlink) !== Number(after.nlink)) return false;
  return Number(before.size) === Number(after.size);
}

function assertOrdinaryFile(
  stats: Awaited<ReturnType<typeof lstat>>,
  filePath: string,
): void {
  if (stats.isSymbolicLink()) {
    throw new Error(`Declaration path is not an ordinary file: ${filePath}.`);
  }
  if (!stats.isFile()) {
    throw new Error(`Declaration path is not an ordinary file: ${filePath}.`);
  }
}

export async function readRegularFileState(
  filePath: string,
): Promise<RegularFileState> {
  const pathStats = await lstat(filePath);
  assertOrdinaryFile(pathStats, filePath);
  const handle = await open(filePath, 'r');
  try {
    const before = await handle.stat();
    if (!hasSameIdentity(pathStats, before)) {
      throw new Error(
        `Declaration file identity drifted while it was opened: ${filePath}.`,
      );
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (!hasStableFileState(before, after)) {
      throw new Error(
        `Declaration file identity drifted while it was read: ${filePath}.`,
      );
    }
    return createFileState(before, content);
  } finally {
    await handle.close();
  }
}

export async function readRegularFileStateIfPresent(
  filePath: string,
): Promise<RegularFileState | undefined> {
  try {
    return await readRegularFileState(filePath);
  } catch (error) {
    if (isMissingError(error)) return undefined;
    throw error;
  }
}

async function readHandleContent(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
): Promise<Buffer> {
  const content = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(content, offset, size - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  return content.subarray(0, offset);
}

export async function readHandleState(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<RegularFileState> {
  const before = await handle.stat();
  if (!before.isFile()) {
    throw new Error('Transaction-owned declaration target is not a file.');
  }
  const content = await readHandleContent(handle, Number(before.size));
  const after = await handle.stat();
  if (!hasStableFileState(before, after)) {
    throw new Error(
      'Transaction-owned declaration identity drifted while it was verified.',
    );
  }
  return createFileState(after, content);
}
