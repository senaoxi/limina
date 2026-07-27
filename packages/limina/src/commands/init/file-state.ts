import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import type { MutationAuthority } from '../../utils/mutation-boundary';
import { preflightMutationBoundary } from '../../utils/mutation-boundary';
import type { FileState } from './mutation-types';

type InitFileHandle = Awaited<ReturnType<typeof open>>;

export function isMissingError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && String(error.code) === 'ENOENT'
  );
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function stateKey(state: FileState): string {
  return JSON.stringify({
    dev: state.dev,
    hash: state.hash,
    ino: state.ino,
    length: state.length,
    mode: state.mode,
    nlink: state.nlink,
  });
}

function assertRegularStats(stats: Stats, message: string): void {
  if (!stats.isFile()) {
    throw new Error(message);
  }
}

async function readHandleContent(
  handle: InitFileHandle,
  size: number,
): Promise<Buffer> {
  const content = Buffer.alloc(size);
  let offset = 0;

  while (offset < size) {
    const result = await handle.read(content, offset, size - offset, offset);

    if (result.bytesRead === 0) {
      break;
    }

    offset += result.bytesRead;
  }

  return content.subarray(0, offset);
}

function hasStableIdentity(before: Stats, after: Stats): boolean {
  return [
    String(before.dev) === String(after.dev),
    String(before.ino) === String(after.ino),
    Number(before.nlink) === Number(after.nlink),
    Number(before.size) === Number(after.size),
  ].every(Boolean);
}

function createFileState(content: Buffer, stats: Stats): FileState {
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

export async function readHandleState(
  handle: InitFileHandle,
): Promise<FileState> {
  const before = await handle.stat();
  assertRegularStats(before, 'Init mutation handle is not a file.');
  const content = await readHandleContent(handle, Number(before.size));
  const after = await handle.stat();

  if (!hasStableIdentity(before, after)) {
    throw new Error('Init mutation file identity drifted during verification.');
  }

  return createFileState(content, after);
}

function assertPathStateMatches(
  filePath: string,
  pathStats: Stats,
  state: FileState,
): void {
  const matches = [
    state.dev === String(pathStats.dev),
    state.ino === String(pathStats.ino),
  ].every(Boolean);

  if (!matches) {
    throw new Error(
      `Init mutation target identity drifted while it was read: ${filePath}.`,
    );
  }
}

export async function readFileState(filePath: string): Promise<FileState> {
  const pathStats = await lstat(filePath);

  if (pathStats.isSymbolicLink()) {
    throw new Error(
      `Init mutation target is not an ordinary file: ${filePath}.`,
    );
  }

  assertRegularStats(
    pathStats,
    `Init mutation target is not an ordinary file: ${filePath}.`,
  );
  const handle = await open(filePath, 'r');

  try {
    const state = await readHandleState(handle);
    assertPathStateMatches(filePath, pathStats, state);
    return state;
  } finally {
    await handle.close();
  }
}

export async function readFileStateIfPresent(
  filePath: string,
): Promise<FileState | undefined> {
  try {
    return await readFileState(filePath);
  } catch (error) {
    if (isMissingError(error)) {
      return undefined;
    }

    throw error;
  }
}

export async function removeIfOwned(options: {
  authority: MutationAuthority;
  expectedState: FileState;
  filePath: string;
}): Promise<void> {
  await preflightMutationBoundary([
    { authority: options.authority, kind: 'file', path: options.filePath },
  ]);
  const current = await readFileStateIfPresent(options.filePath);
  const matches =
    current !== undefined &&
    stateKey(current) === stateKey(options.expectedState);

  if (!matches) {
    throw new Error(
      `Refusing to clean up an init file whose identity drifted: ${options.filePath}.`,
    );
  }

  await unlink(options.filePath);
}

export function throwCombined(
  primary: unknown,
  cleanupErrors: readonly Error[],
): never {
  const error = toError(primary);

  if (cleanupErrors.length === 0) {
    throw error;
  }

  throw new AggregateError(
    [error, ...cleanupErrors],
    `${error.message}\nInit cleanup also failed:\n${cleanupErrors
      .map((cleanupError) => `  - ${cleanupError.message}`)
      .join('\n')}`,
    { cause: error },
  );
}
