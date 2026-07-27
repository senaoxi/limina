import { randomUUID } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import path from 'pathe';
import {
  assertArtifactPathOperationSafe,
  ensureArtifactParentDirectory,
  type LiminaArtifactNamespace,
} from '../domain/artifacts/namespace';
import { replaceFileWithRetry } from './atomic-replace';

const TEMP_CREATE_ATTEMPTS = 8;

export type AtomicFileHandle = Pick<
  Awaited<ReturnType<typeof open>>,
  'close' | 'sync' | 'writeFile'
>;

export interface AtomicWriteOptions {
  createTempPath?: (attempt: number) => string;
  openTemp?: (path: string, flags: 'wx') => Promise<AtomicFileHandle>;
  removeTemp?: (path: string) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  retryDelaysMs?: readonly number[];
  serialize?: (value: unknown) => string;
  tempCreateAttempts?: number;
}

export interface AtomicWriteContext {
  namespace: LiminaArtifactNamespace;
  options: AtomicWriteOptions;
  targetPath: string;
  value: unknown;
}

interface AtomicWriteState {
  handle?: AtomicFileHandle;
  tempPath?: string;
}

interface TempCreationContext {
  atomicWrite: AtomicWriteContext;
  createTempPath: (attempt: number) => string;
  openTemp: NonNullable<AtomicWriteOptions['openTemp']>;
  totalAttempts: number;
}

function ignoreError(error: unknown): void {
  String(error);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && 'code' in error && String(error.code) === code
  );
}

function createDefaultTempPath(targetPath: string): string {
  return path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
}

function resolveTempPathFactory(
  context: AtomicWriteContext,
): (attempt: number) => string {
  if (context.options.createTempPath !== undefined) {
    return context.options.createTempPath;
  }

  return () => createDefaultTempPath(context.targetPath);
}

function resolveOpenTemp(
  options: AtomicWriteOptions,
): NonNullable<AtomicWriteOptions['openTemp']> {
  return options.openTemp === undefined ? open : options.openTemp;
}

function resolveTempCreateAttempts(options: AtomicWriteOptions): number {
  const attempts =
    options.tempCreateAttempts === undefined
      ? TEMP_CREATE_ATTEMPTS
      : options.tempCreateAttempts;
  return Math.max(1, attempts);
}

function canRetryTempCreation(
  error: unknown,
  attempt: number,
  totalAttempts: number,
): boolean {
  return hasErrorCode(error, 'EEXIST') && attempt + 1 < totalAttempts;
}

function handleTempCreationError(
  error: unknown,
  attempt: number,
  totalAttempts: number,
): null {
  if (!canRetryTempCreation(error, attempt, totalAttempts)) {
    throw error;
  }

  return null;
}

async function tryCreateTempFile(
  context: TempCreationContext,
  attempt: number,
): Promise<Required<AtomicWriteState> | null> {
  const candidatePath = context.createTempPath(attempt);

  try {
    await assertArtifactPathOperationSafe(
      context.atomicWrite.namespace,
      candidatePath,
      { targetKind: 'file' },
    );
    const handle = await context.openTemp(candidatePath, 'wx');
    return { handle, tempPath: candidatePath };
  } catch (error) {
    return handleTempCreationError(error, attempt, context.totalAttempts);
  }
}

function createTempCreationContext(
  atomicWrite: AtomicWriteContext,
): TempCreationContext {
  return {
    atomicWrite,
    createTempPath: resolveTempPathFactory(atomicWrite),
    openTemp: resolveOpenTemp(atomicWrite.options),
    totalAttempts: resolveTempCreateAttempts(atomicWrite.options),
  };
}

async function createTempFile(
  atomicWrite: AtomicWriteContext,
): Promise<Required<AtomicWriteState>> {
  const context = createTempCreationContext(atomicWrite);

  for (let attempt = 0; attempt < context.totalAttempts; attempt += 1) {
    const state = await tryCreateTempFile(context, attempt);

    if (state !== null) {
      return state;
    }
  }

  throw new Error(
    `Unable to create an atomic temp file for ${atomicWrite.targetPath}.`,
  );
}

function serializeValue(context: AtomicWriteContext): string {
  if (context.options.serialize !== undefined) {
    return context.options.serialize(context.value);
  }

  return JSON.stringify(context.value, null, 2);
}

function requireHandle(
  context: AtomicWriteContext,
  state: AtomicWriteState,
): AtomicFileHandle {
  if (state.handle === undefined) {
    throw new Error(
      `Atomic temp file handle is missing for ${context.targetPath}.`,
    );
  }

  return state.handle;
}

function requireTempPath(
  context: AtomicWriteContext,
  state: AtomicWriteState,
): string {
  if (state.tempPath === undefined) {
    throw new Error(
      `Atomic temp file path is missing for ${context.targetPath}.`,
    );
  }

  return state.tempPath;
}

async function writeAndCloseTempFile(
  context: AtomicWriteContext,
  state: AtomicWriteState,
): Promise<void> {
  const handle = requireHandle(context, state);
  await handle.writeFile(`${serializeValue(context)}\n`, 'utf8');
  await handle.sync();
  await handle.close();
  state.handle = undefined;
}

async function assertReplacementPathsSafe(
  context: AtomicWriteContext,
  tempPath: string,
): Promise<void> {
  await assertArtifactPathOperationSafe(context.namespace, tempPath, {
    targetKind: 'file',
  });
  await assertArtifactPathOperationSafe(context.namespace, context.targetPath, {
    targetKind: 'file',
  });
}

async function replaceTempFile(
  context: AtomicWriteContext,
  state: AtomicWriteState,
): Promise<void> {
  const tempPath = requireTempPath(context, state);
  await replaceFileWithRetry(tempPath, context.targetPath, {
    beforeAttempt: () => assertReplacementPathsSafe(context, tempPath),
    replace: context.options.rename,
    retryDelaysMs: context.options.retryDelaysMs,
  });
}

async function removeTempFile(
  context: AtomicWriteContext,
  tempPath: string,
): Promise<void> {
  await assertArtifactPathOperationSafe(context.namespace, tempPath, {
    targetKind: 'file',
  });

  if (context.options.removeTemp !== undefined) {
    await context.options.removeTemp(tempPath);
    return;
  }

  await rm(tempPath, { force: true });
}

async function closeHandle(state: AtomicWriteState): Promise<void> {
  if (state.handle !== undefined) {
    await state.handle.close().catch(ignoreError);
  }
}

async function cleanupTempPath(
  context: AtomicWriteContext,
  state: AtomicWriteState,
): Promise<void> {
  if (state.tempPath !== undefined) {
    await removeTempFile(context, state.tempPath).catch(ignoreError);
  }
}

async function cleanupAtomicWrite(
  context: AtomicWriteContext,
  state: AtomicWriteState,
): Promise<void> {
  await closeHandle(state);
  await cleanupTempPath(context, state);
}

export async function performAtomicJsonWrite(
  context: AtomicWriteContext,
): Promise<void> {
  const state: AtomicWriteState = {};

  try {
    await ensureArtifactParentDirectory(context.namespace, context.targetPath);
    Object.assign(state, await createTempFile(context));
    await writeAndCloseTempFile(context, state);
    await replaceTempFile(context, state);
  } catch (error) {
    await cleanupAtomicWrite(context, state);
    throw error;
  }
}
