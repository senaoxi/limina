import { preflightMutationBoundary } from '#utils/mutation-boundary';
import { open, unlink } from 'node:fs/promises';
import {
  fileIdentityKey,
  readHandleState,
  readRegularFileStateIfPresent,
} from './state';
import type { OwnedDeclarationFile, PreparedDeclarationEntry } from './types';

export class ExclusivePublicationError extends Error {
  readonly cleanupErrors: Error[];
  readonly ownedFile?: OwnedDeclarationFile;

  constructor(options: {
    cause: unknown;
    cleanupErrors?: Error[];
    ownedFile?: OwnedDeclarationFile;
  }) {
    const cause = toError(options.cause);
    super(cause.message, { cause });
    this.name = 'ExclusivePublicationError';
    this.cleanupErrors = getCleanupErrors(options.cleanupErrors);
    if (options.ownedFile !== undefined) {
      this.ownedFile = options.ownedFile;
    }
  }
}

function getCleanupErrors(errors: Error[] | undefined): Error[] {
  return errors === undefined ? [] : errors;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function createOwnedFile(options: {
  prepared: PreparedDeclarationEntry;
  state: Awaited<ReturnType<typeof readHandleState>>;
  transactionToken: string;
}): OwnedDeclarationFile {
  return {
    authority: options.prepared.authority,
    path: options.prepared.entry.targetPath,
    state: options.state,
    transactionToken: options.transactionToken,
  };
}

function assertPublishedContent(
  prepared: PreparedDeclarationEntry,
  ownedFile: OwnedDeclarationFile,
): void {
  if (ownedFile.state.content.equals(prepared.sourceState.content)) return;
  throw new Error(
    `Exclusive declaration publication content verification failed: ${prepared.entry.targetPath}.`,
  );
}

async function writePublishedFile(options: {
  handle: Awaited<ReturnType<typeof open>>;
  prepared: PreparedDeclarationEntry;
  transactionToken: string;
}): Promise<OwnedDeclarationFile> {
  await options.handle.writeFile(options.prepared.sourceState.content);
  await options.handle.sync();
  const ownedFile = createOwnedFile({
    prepared: options.prepared,
    state: await readHandleState(options.handle),
    transactionToken: options.transactionToken,
  });
  assertPublishedContent(options.prepared, ownedFile);
  return ownedFile;
}

async function captureCloseError(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<Error | undefined> {
  try {
    await handle.close();
    return undefined;
  } catch (error) {
    return toError(error);
  }
}

function getCloseCleanupErrors(closeError: Error | undefined): Error[] {
  return closeError === undefined ? [] : [closeError];
}

function throwPublicationFailure(options: {
  closeError: Error | undefined;
  ownedFile: OwnedDeclarationFile | undefined;
  primaryError: unknown;
}): never {
  if (options.primaryError !== undefined) {
    throw new ExclusivePublicationError({
      cause: options.primaryError,
      cleanupErrors: getCloseCleanupErrors(options.closeError),
      ownedFile: options.ownedFile,
    });
  }
  throw new ExclusivePublicationError({
    cause: options.closeError,
    ownedFile: options.ownedFile,
  });
}

async function openPublicationHandle(
  targetPath: string,
): Promise<Awaited<ReturnType<typeof open>>> {
  try {
    return await open(targetPath, 'wx+');
  } catch (error) {
    throw new ExclusivePublicationError({ cause: error });
  }
}

async function attemptPublication(options: {
  handle: Awaited<ReturnType<typeof open>>;
  prepared: PreparedDeclarationEntry;
  transactionToken: string;
}): Promise<{
  ownedFile: OwnedDeclarationFile | undefined;
  primaryError: unknown;
}> {
  try {
    return {
      ownedFile: await writePublishedFile(options),
      primaryError: undefined,
    };
  } catch (error) {
    return { ownedFile: undefined, primaryError: error };
  }
}

function hasPublicationError(options: {
  closeError: Error | undefined;
  primaryError: unknown;
}): boolean {
  if (options.primaryError !== undefined) return true;
  return options.closeError !== undefined;
}

function requireOwnedFile(
  ownedFile: OwnedDeclarationFile | undefined,
  targetPath: string,
): OwnedDeclarationFile {
  if (ownedFile !== undefined) return ownedFile;
  throw new ExclusivePublicationError({
    cause: new Error(
      `Unable to capture transaction-owned declaration identity: ${targetPath}.`,
    ),
  });
}

function resolvePublicationResult(options: {
  closeError: Error | undefined;
  ownedFile: OwnedDeclarationFile | undefined;
  primaryError: unknown;
  targetPath: string;
}): OwnedDeclarationFile {
  if (hasPublicationError(options)) {
    throwPublicationFailure(options);
  }
  return requireOwnedFile(options.ownedFile, options.targetPath);
}

export async function publishDeclarationExclusive(options: {
  prepared: PreparedDeclarationEntry;
  transactionToken: string;
}): Promise<OwnedDeclarationFile> {
  const targetPath = options.prepared.entry.targetPath;
  const handle = await openPublicationHandle(targetPath);
  const attempt = await attemptPublication({ ...options, handle });
  return resolvePublicationResult({
    closeError: await captureCloseError(handle),
    ownedFile: attempt.ownedFile,
    primaryError: attempt.primaryError,
    targetPath,
  });
}

export async function rollbackOwnedFile(
  owned: OwnedDeclarationFile,
): Promise<void> {
  await preflightMutationBoundary([
    {
      authority: owned.authority,
      kind: 'file',
      path: owned.path,
    },
  ]);
  const current = await readRegularFileStateIfPresent(owned.path);
  if (current === undefined) {
    throw new Error(
      `Refusing to delete a declaration target whose transaction identity drifted: ${owned.path}.`,
    );
  }
  if (fileIdentityKey(current) !== fileIdentityKey(owned.state)) {
    throw new Error(
      `Refusing to delete a declaration target whose transaction identity drifted: ${owned.path}.`,
    );
  }
  await unlink(owned.path);
}
