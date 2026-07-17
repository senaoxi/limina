import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, rename, rm, unlink } from 'node:fs/promises';
import path from 'pathe';
import {
  createExplicitMutationAuthority,
  type MutationAuthority,
  type MutationBoundarySnapshot,
  type MutationBoundaryTarget,
  preflightMutationBoundary,
  recheckMutationBoundary,
} from '../utils/mutation-boundary';

interface FileState {
  readonly content: Buffer;
  readonly dev: string;
  readonly hash: string;
  readonly ino: string;
  readonly length: number;
  readonly mode: number;
  readonly nlink: number;
}

interface InitFileMutationPlan {
  readonly authority: MutationAuthority;
  readonly snapshot: MutationBoundarySnapshot;
  readonly targetPath: string;
  readonly tempAuthority: MutationAuthority;
  readonly tempPath: string;
  readonly tempSnapshot: MutationBoundarySnapshot;
}

export interface InitMutationContext {
  readonly filePlans: ReadonlyMap<string, InitFileMutationPlan>;
  readonly generatedRootAuthority: MutationAuthority;
  readonly generatedRootPath: string;
}

function isMissingError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && String(error.code) === 'ENOENT'
  );
}

function stateKey(state: FileState): string {
  return JSON.stringify({
    dev: state.dev,
    hash: state.hash,
    ino: state.ino,
    length: state.length,
    mode: state.mode,
    nlink: state.nlink,
  });
}

async function readHandleState(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<FileState> {
  const before = await handle.stat();
  if (!before.isFile()) throw new Error('Init mutation handle is not a file.');
  const size = Number(before.size);
  const content = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(content, offset, size - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  const actual = content.subarray(0, offset);
  const after = await handle.stat();
  if (
    String(before.dev) !== String(after.dev) ||
    String(before.ino) !== String(after.ino) ||
    Number(before.nlink) !== Number(after.nlink) ||
    Number(before.size) !== Number(after.size)
  ) {
    throw new Error('Init mutation file identity drifted during verification.');
  }
  return {
    content: actual,
    dev: String(after.dev),
    hash: createHash('sha256').update(actual).digest('hex'),
    ino: String(after.ino),
    length: actual.byteLength,
    mode: Number(after.mode) & 0o7777,
    nlink: Number(after.nlink),
  };
}

async function readFileState(filePath: string): Promise<FileState> {
  const pathStats = await lstat(filePath);
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    throw new Error(
      `Init mutation target is not an ordinary file: ${filePath}.`,
    );
  }
  const handle = await open(filePath, 'r');
  try {
    const state = await readHandleState(handle);
    if (
      state.dev !== String(pathStats.dev) ||
      state.ino !== String(pathStats.ino)
    ) {
      throw new Error(
        `Init mutation target identity drifted while it was read: ${filePath}.`,
      );
    }
    return state;
  } finally {
    await handle.close();
  }
}

async function readFileStateIfPresent(
  filePath: string,
): Promise<FileState | undefined> {
  try {
    return await readFileState(filePath);
  } catch (error) {
    if (isMissingError(error)) return undefined;
    throw error;
  }
}

async function removeIfOwned(options: {
  authority: MutationAuthority;
  expectedState: FileState;
  filePath: string;
}): Promise<void> {
  await preflightMutationBoundary([
    { authority: options.authority, kind: 'file', path: options.filePath },
  ]);
  const current = await readFileStateIfPresent(options.filePath);
  if (!current || stateKey(current) !== stateKey(options.expectedState)) {
    throw new Error(
      `Refusing to clean up an init file whose identity drifted: ${options.filePath}.`,
    );
  }
  await unlink(options.filePath);
}

function throwCombined(
  primary: unknown,
  cleanupErrors: readonly Error[],
): never {
  const error = primary instanceof Error ? primary : new Error(String(primary));
  if (cleanupErrors.length === 0) throw error;
  throw new AggregateError(
    [error, ...cleanupErrors],
    `${error.message}\nInit cleanup also failed:\n${cleanupErrors
      .map((cleanupError) => `  - ${cleanupError.message}`)
      .join('\n')}`,
    { cause: error },
  );
}

async function writeExclusive(options: {
  authority: MutationAuthority;
  content: Buffer;
  filePath: string;
  mode?: number;
}): Promise<FileState> {
  const handle = await open(options.filePath, 'wx+');
  let state: FileState | undefined;
  let primary: unknown;
  const cleanupErrors: Error[] = [];
  try {
    try {
      await handle.writeFile(options.content);
      if (options.mode !== undefined) await handle.chmod(options.mode);
      await handle.sync();
    } catch (error) {
      primary = error;
    }
    try {
      state = await readHandleState(handle);
      if (!primary && !state.content.equals(options.content)) {
        primary = new Error(
          `Init exclusive publication verification failed: ${options.filePath}.`,
        );
      }
    } catch (error) {
      if (primary) {
        cleanupErrors.push(
          error instanceof Error ? error : new Error(String(error)),
        );
      } else {
        primary = error;
      }
    }
  } finally {
    try {
      await handle.close();
    } catch (error) {
      const closeError =
        error instanceof Error ? error : new Error(String(error));
      if (primary) cleanupErrors.push(closeError);
      else primary = closeError;
    }
  }
  if (primary) {
    if (state) {
      try {
        await removeIfOwned({
          authority: options.authority,
          expectedState: state,
          filePath: options.filePath,
        });
      } catch (error) {
        cleanupErrors.push(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    throwCombined(primary, cleanupErrors);
  }
  if (!state)
    throw new Error(`Unable to verify init file ${options.filePath}.`);
  return state;
}

export async function prepareInitMutationContext(options: {
  fileNames: readonly string[];
  rootDir: string;
}): Promise<InitMutationContext> {
  const generation = randomUUID();
  const generatedRootPath = path.join(options.rootDir, '.limina');
  const generatedRootAuthority = await createExplicitMutationAuthority({
    generation,
    logicalMutationRoot: generatedRootPath,
    scope: 'directory',
    trustedBasePath: options.rootDir,
  });
  const generatedRootTarget: MutationBoundaryTarget = {
    authority: generatedRootAuthority,
    kind: 'directory',
    path: generatedRootPath,
    recursive: true,
  };
  const filePlans = new Map<string, InitFileMutationPlan>();
  const allTargets: MutationBoundaryTarget[] = [generatedRootTarget];

  for (const fileName of options.fileNames) {
    const targetPath = path.join(options.rootDir, fileName);
    const tempPath = path.join(
      options.rootDir,
      `.${fileName}.${process.pid}.${randomUUID()}.tmp`,
    );
    const authority = await createExplicitMutationAuthority({
      generation,
      logicalMutationRoot: targetPath,
      scope: 'file',
      trustedBasePath: options.rootDir,
    });
    const tempAuthority = await createExplicitMutationAuthority({
      generation,
      logicalMutationRoot: tempPath,
      scope: 'file',
      trustedBasePath: options.rootDir,
    });
    const target: MutationBoundaryTarget = {
      authority,
      kind: 'file',
      path: targetPath,
    };
    const tempTarget: MutationBoundaryTarget = {
      authority: tempAuthority,
      kind: 'file',
      path: tempPath,
    };
    const [snapshot, tempSnapshot] = await Promise.all([
      preflightMutationBoundary([target]),
      preflightMutationBoundary([tempTarget]),
    ]);
    filePlans.set(targetPath, {
      authority,
      snapshot,
      targetPath,
      tempAuthority,
      tempPath,
      tempSnapshot,
    });
    allTargets.push(target, tempTarget);
  }

  await preflightMutationBoundary(allTargets);
  return {
    filePlans,
    generatedRootAuthority,
    generatedRootPath,
  };
}

export async function removeInitGeneratedRoot(
  context: InitMutationContext,
): Promise<boolean> {
  try {
    await lstat(context.generatedRootPath);
  } catch (error) {
    if (isMissingError(error)) return false;
    throw error;
  }
  await preflightMutationBoundary([
    {
      authority: context.generatedRootAuthority,
      kind: 'directory',
      path: context.generatedRootPath,
      recursive: true,
    },
  ]);
  await rm(context.generatedRootPath, { force: true, recursive: true });
  return true;
}

export async function writeInitFile(options: {
  content: string;
  context: InitMutationContext;
  filePath: string;
}): Promise<void> {
  const plan = options.context.filePlans.get(options.filePath);
  if (!plan) {
    throw new Error(`Missing init mutation plan for ${options.filePath}.`);
  }
  await recheckMutationBoundary(plan.snapshot);
  await recheckMutationBoundary(plan.tempSnapshot);
  const existingState = await readFileStateIfPresent(plan.targetPath);
  const content = Buffer.from(options.content);
  if (!existingState) {
    await writeExclusive({
      authority: plan.authority,
      content,
      filePath: plan.targetPath,
    });
    return;
  }

  const tempState = await writeExclusive({
    authority: plan.tempAuthority,
    content,
    filePath: plan.tempPath,
    mode: existingState.mode,
  });
  try {
    const current = await readFileState(plan.targetPath);
    if (stateKey(current) !== stateKey(existingState)) {
      throw new Error(
        `Init target drifted before replacement: ${plan.targetPath}.`,
      );
    }
    await preflightMutationBoundary([
      { authority: plan.authority, kind: 'file', path: plan.targetPath },
      { authority: plan.tempAuthority, kind: 'file', path: plan.tempPath },
    ]);
    await rename(plan.tempPath, plan.targetPath);
  } catch (error) {
    const cleanupErrors: Error[] = [];
    try {
      await removeIfOwned({
        authority: plan.tempAuthority,
        expectedState: tempState,
        filePath: plan.tempPath,
      });
    } catch (cleanupError) {
      cleanupErrors.push(
        cleanupError instanceof Error
          ? cleanupError
          : new Error(String(cleanupError)),
      );
    }
    throwCombined(error, cleanupErrors);
  }
}
