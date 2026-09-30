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
  appendNewline?: boolean;
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

interface TemporaryCreationContext {
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

function createDefaultTemporaryPath(targetPath: string): string {
  return path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
}

function resolveTemporaryPathFactory(
  context: AtomicWriteContext,
): (attempt: number) => string {
  return context.options.createTempPath === undefined
    ? () => createDefaultTemporaryPath(context.targetPath)
    : context.options.createTempPath;
}

function resolveOpenTemporary(
  options: AtomicWriteOptions,
): NonNullable<AtomicWriteOptions['openTemp']> {
  return options.openTemp === undefined ? open : options.openTemp;
}

function resolveTemporaryCreateAttempts(options: AtomicWriteOptions): number {
  const attempts =
    options.tempCreateAttempts === undefined
      ? TEMP_CREATE_ATTEMPTS
      : options.tempCreateAttempts;
  return Math.max(1, attempts);
}

function canRetryTemporaryCreation(
  error: unknown,
  attempt: number,
  totalAttempts: number,
): boolean {
  return hasErrorCode(error, 'EEXIST') && attempt + 1 < totalAttempts;
}

function handleTemporaryCreationError(
  error: unknown,
  attempt: number,
  totalAttempts: number,
): null {
  if (!canRetryTemporaryCreation(error, attempt, totalAttempts)) {
    throw error;
  }

  return null;
}

async function tryCreateTemporaryFile(
  context: TemporaryCreationContext,
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
    return handleTemporaryCreationError(error, attempt, context.totalAttempts);
  }
}

function createTemporaryCreationContext(
  atomicWrite: AtomicWriteContext,
): TemporaryCreationContext {
  return {
    atomicWrite,
    createTempPath: resolveTemporaryPathFactory(atomicWrite),
    openTemp: resolveOpenTemporary(atomicWrite.options),
    totalAttempts: resolveTemporaryCreateAttempts(atomicWrite.options),
  };
}

async function createTemporaryFile(
  atomicWrite: AtomicWriteContext,
): Promise<Required<AtomicWriteState>> {
  const context = createTemporaryCreationContext(atomicWrite);

  for (let attempt = 0; attempt < context.totalAttempts; attempt += 1) {
    const state = await tryCreateTemporaryFile(context, attempt);

    if (state !== null) {
      return state;
    }
  }

  throw new Error(
    `Unable to create an atomic temp file for ${atomicWrite.targetPath}.`,
  );
}

function serializeValue(context: AtomicWriteContext): string {
  return context.options.serialize === undefined
    ? JSON.stringify(context.value, null, 2)
    : context.options.serialize(context.value);
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

function requireTemporaryPath(
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

async function writeAndCloseTemporaryFile(
  context: AtomicWriteContext,
  state: AtomicWriteState,
): Promise<void> {
  const handle = requireHandle(context, state);
  const content = serializeValue(context);
  await handle.writeFile(
    context.options.appendNewline === false ? content : `${content}\n`,
    'utf8',
  );
  await handle.sync();
  await handle.close();
  state.handle = undefined;
}

async function assertReplacementPathsSafe(
  context: AtomicWriteContext,
  temporaryPath: string,
): Promise<void> {
  await assertArtifactPathOperationSafe(context.namespace, temporaryPath, {
    targetKind: 'file',
  });
  await assertArtifactPathOperationSafe(context.namespace, context.targetPath, {
    targetKind: 'file',
  });
}

async function replaceTemporaryFile(
  context: AtomicWriteContext,
  state: AtomicWriteState,
): Promise<void> {
  const temporaryPath = requireTemporaryPath(context, state);
  await replaceFileWithRetry(temporaryPath, context.targetPath, {
    beforeAttempt: () => assertReplacementPathsSafe(context, temporaryPath),
    replace: context.options.rename,
    retryDelaysMs: context.options.retryDelaysMs,
  });
}

async function removeTemporaryFile(
  context: AtomicWriteContext,
  temporaryPath: string,
): Promise<void> {
  await assertArtifactPathOperationSafe(context.namespace, temporaryPath, {
    targetKind: 'file',
  });

  if (context.options.removeTemp !== undefined) {
    await context.options.removeTemp(temporaryPath);
    return;
  }

  await rm(temporaryPath, { force: true });
}

async function closeHandle(state: AtomicWriteState): Promise<void> {
  if (state.handle === undefined) {
    return;
  }

  const cleanup = state.handle.close();
  try {
    await cleanup;
  } catch (error) {
    ignoreError(error);
  }
}

async function cleanupTemporaryPath(
  context: AtomicWriteContext,
  state: AtomicWriteState,
): Promise<void> {
  if (state.tempPath === undefined) {
    return;
  }

  const cleanup = removeTemporaryFile(context, state.tempPath);
  try {
    await cleanup;
  } catch (error) {
    ignoreError(error);
  }
}

async function cleanupAtomicWrite(
  context: AtomicWriteContext,
  state: AtomicWriteState,
): Promise<void> {
  await closeHandle(state);
  await cleanupTemporaryPath(context, state);
}

export async function performAtomicJsonWrite(
  context: AtomicWriteContext,
): Promise<void> {
  const state: AtomicWriteState = {};

  try {
    await ensureArtifactParentDirectory(context.namespace, context.targetPath);
    Object.assign(state, await createTemporaryFile(context));
    await writeAndCloseTemporaryFile(context, state);
    await replaceTemporaryFile(context, state);
  } catch (error) {
    await cleanupAtomicWrite(context, state);
    throw error;
  }
}
