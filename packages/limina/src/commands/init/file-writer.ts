import { open, rename } from 'node:fs/promises';
import {
  preflightMutationBoundary,
  recheckMutationBoundary,
} from '../../utils/mutation-boundary';
import {
  readFileState,
  readFileStateIfPresent,
  readHandleState,
  removeIfOwned,
  stateKey,
  throwCombined,
  toError,
} from './file-state';
import type {
  FileState,
  InitFileMutationPlan,
  InitMutationContext,
} from './mutation-types';

type InitFileHandle = Awaited<ReturnType<typeof open>>;

interface WriteExclusiveOptions {
  authority: InitFileMutationPlan['authority'];
  content: Buffer;
  filePath: string;
  mode?: number;
}

interface WriteSession {
  cleanupErrors: Error[];
  handle: InitFileHandle;
  primary?: unknown;
  state?: FileState;
}

function recordFailure(session: WriteSession, error: unknown): void {
  if (session.primary === undefined) {
    session.primary = error;
    return;
  }

  session.cleanupErrors.push(toError(error));
}

async function writeContent(
  options: WriteExclusiveOptions,
  session: WriteSession,
): Promise<void> {
  try {
    await session.handle.writeFile(options.content);

    if (options.mode !== undefined) {
      await session.handle.chmod(options.mode);
    }

    await session.handle.sync();
  } catch (error) {
    recordFailure(session, error);
  }
}

function shouldVerifyContent(session: WriteSession): boolean {
  return session.state !== undefined && session.primary === undefined;
}

function verifyContent(
  options: WriteExclusiveOptions,
  session: WriteSession,
): void {
  if (!shouldVerifyContent(session)) {
    return;
  }

  if (!session.state!.content.equals(options.content)) {
    session.primary = new Error(
      `Init exclusive publication verification failed: ${options.filePath}.`,
    );
  }
}

async function readPublishedState(
  options: WriteExclusiveOptions,
  session: WriteSession,
): Promise<void> {
  try {
    session.state = await readHandleState(session.handle);
    verifyContent(options, session);
  } catch (error) {
    recordFailure(session, error);
  }
}

async function closeWriteHandle(session: WriteSession): Promise<void> {
  try {
    await session.handle.close();
  } catch (error) {
    recordFailure(session, error);
  }
}

async function cleanupPublishedFile(
  options: WriteExclusiveOptions,
  session: WriteSession,
): Promise<void> {
  if (session.state === undefined) {
    return;
  }

  try {
    await removeIfOwned({
      authority: options.authority,
      expectedState: session.state,
      filePath: options.filePath,
    });
  } catch (error) {
    session.cleanupErrors.push(toError(error));
  }
}

async function resolveWriteResult(
  options: WriteExclusiveOptions,
  session: WriteSession,
): Promise<FileState> {
  if (session.primary !== undefined) {
    await cleanupPublishedFile(options, session);
    throwCombined(session.primary, session.cleanupErrors);
  }

  if (session.state === undefined) {
    throw new Error(`Unable to verify init file ${options.filePath}.`);
  }

  return session.state;
}

async function writeExclusive(
  options: WriteExclusiveOptions,
): Promise<FileState> {
  const session: WriteSession = {
    cleanupErrors: [],
    handle: await open(options.filePath, 'wx+'),
  };

  await writeContent(options, session);
  await readPublishedState(options, session);
  await closeWriteHandle(session);
  return resolveWriteResult(options, session);
}

function getMutationPlan(
  context: InitMutationContext,
  filePath: string,
): InitFileMutationPlan {
  const plan = context.filePlans.get(filePath);

  if (plan === undefined) {
    throw new Error(`Missing init mutation plan for ${filePath}.`);
  }

  return plan;
}

async function assertExistingState(
  plan: InitFileMutationPlan,
  expectedState: FileState,
): Promise<void> {
  const current = await readFileState(plan.targetPath);

  if (stateKey(current) !== stateKey(expectedState)) {
    throw new Error(
      `Init target drifted before replacement: ${plan.targetPath}.`,
    );
  }
}

async function authorizeReplacement(plan: InitFileMutationPlan): Promise<void> {
  await preflightMutationBoundary([
    { authority: plan.authority, kind: 'file', path: plan.targetPath },
    { authority: plan.tempAuthority, kind: 'file', path: plan.tempPath },
  ]);
}

async function cleanupTempFile(
  plan: InitFileMutationPlan,
  tempState: FileState,
): Promise<Error[]> {
  try {
    await removeIfOwned({
      authority: plan.tempAuthority,
      expectedState: tempState,
      filePath: plan.tempPath,
    });
    return [];
  } catch (error) {
    return [toError(error)];
  }
}

async function replaceExistingFile(options: {
  content: Buffer;
  existingState: FileState;
  plan: InitFileMutationPlan;
}): Promise<void> {
  const tempState = await writeExclusive({
    authority: options.plan.tempAuthority,
    content: options.content,
    filePath: options.plan.tempPath,
    mode: options.existingState.mode,
  });

  try {
    await assertExistingState(options.plan, options.existingState);
    await authorizeReplacement(options.plan);
    await rename(options.plan.tempPath, options.plan.targetPath);
  } catch (error) {
    throwCombined(error, await cleanupTempFile(options.plan, tempState));
  }
}

async function publishInitFile(options: {
  content: Buffer;
  existingState: FileState | undefined;
  plan: InitFileMutationPlan;
}): Promise<void> {
  if (options.existingState === undefined) {
    await writeExclusive({
      authority: options.plan.authority,
      content: options.content,
      filePath: options.plan.targetPath,
    });
    return;
  }

  await replaceExistingFile({
    content: options.content,
    existingState: options.existingState,
    plan: options.plan,
  });
}

export async function writeInitFile(options: {
  content: string;
  context: InitMutationContext;
  filePath: string;
}): Promise<void> {
  const plan = getMutationPlan(options.context, options.filePath);
  await recheckMutationBoundary(plan.snapshot);
  await recheckMutationBoundary(plan.tempSnapshot);
  await publishInitFile({
    content: Buffer.from(options.content),
    existingState: await readFileStateIfPresent(plan.targetPath),
    plan,
  });
}
