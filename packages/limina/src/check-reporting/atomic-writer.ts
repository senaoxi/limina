import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import path from 'pathe';
import {
  assertArtifactPathOperationSafe,
  ensureArtifactParentDirectory,
  type LiminaArtifactNamespace,
} from '../domain/artifacts/namespace';

const RETRYABLE_REPLACE_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
// Windows can temporarily deny replacement while readers, indexers, or
// antivirus scanners still hold the destination. Keep retrying long enough
// for those short-lived handles to drain without ever removing the old file.
const REPLACE_RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 400, 800] as const;
const TEMP_CREATE_ATTEMPTS = 8;

type AtomicFileHandle = Pick<
  Awaited<ReturnType<typeof open>>,
  'close' | 'sync' | 'writeFile'
>;

export interface AtomicWriteOptions {
  createTempPath?: (attempt: number) => string;
  openTemp?: (path: string, flags: 'wx') => Promise<AtomicFileHandle>;
  removeTemp?: (path: string) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  retryDelaysMs?: readonly number[];
  tempCreateAttempts?: number;
}

const writesByTargetPath = new Map<string, Promise<void>>();

export interface ReplaceFileWithRetryOptions {
  beforeAttempt?: (context: {
    attempt: number;
    sourcePath: string;
    targetPath: string;
  }) => Promise<void>;
  replace?: (sourcePath: string, targetPath: string) => Promise<void>;
  retryDelaysMs?: readonly number[];
}

export class ReplacementDriftError extends Error {
  override readonly name = 'ReplacementDriftError';
}

export class RetryableReplacementValidationIoError extends Error {
  override readonly name = 'RetryableReplacementValidationIoError';
  readonly code: 'EACCES' | 'EBUSY' | 'EPERM';

  constructor(
    code: 'EACCES' | 'EBUSY' | 'EPERM',
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.code = code;
  }
}

export class TerminalReplacementValidationError extends Error {
  override readonly name = 'TerminalReplacementValidationError';
}

function isRetryableReplaceError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    RETRYABLE_REPLACE_CODES.has(String(error.code))
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function replaceFileWithRetry(
  sourcePath: string,
  targetPath: string,
  options: ReplaceFileWithRetryOptions = {},
): Promise<void> {
  const retryDelays = options.retryDelaysMs ?? REPLACE_RETRY_DELAYS_MS;
  const replace = options.replace ?? rename;

  for (let attempt = 0; ; attempt += 1) {
    try {
      await options.beforeAttempt?.({
        attempt,
        sourcePath,
        targetPath,
      });
    } catch (error) {
      if (
        !(error instanceof RetryableReplacementValidationIoError) ||
        attempt >= retryDelays.length
      ) {
        throw error;
      }

      await delay(retryDelays[attempt]!);
      continue;
    }

    try {
      await replace(sourcePath, targetPath);
      return;
    } catch (error) {
      if (!isRetryableReplaceError(error) || attempt >= retryDelays.length) {
        throw error;
      }

      await delay(retryDelays[attempt]!);
    }
  }
}

function ignoreError(error: unknown): void {
  // Best-effort cleanup must not replace the primary writer error.
  String(error);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && 'code' in error && String(error.code) === code
  );
}

async function performAtomicJsonWrite(
  namespace: LiminaArtifactNamespace,
  targetPath: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const createTempPath =
    options.createTempPath ??
    (() =>
      path.join(
        path.dirname(targetPath),
        `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
      ));
  const openTemp = options.openTemp ?? open;
  const tempCreateAttempts = Math.max(
    1,
    options.tempCreateAttempts ?? TEMP_CREATE_ATTEMPTS,
  );
  let handle: AtomicFileHandle | undefined;
  let tempPath: string | undefined;

  try {
    await ensureArtifactParentDirectory(namespace, targetPath);
    for (let attempt = 0; attempt < tempCreateAttempts; attempt += 1) {
      const candidatePath = createTempPath(attempt);
      try {
        await assertArtifactPathOperationSafe(namespace, candidatePath, {
          targetKind: 'file',
        });
        handle = await openTemp(candidatePath, 'wx');
        tempPath = candidatePath;
        break;
      } catch (error) {
        if (
          !hasErrorCode(error, 'EEXIST') ||
          attempt + 1 >= tempCreateAttempts
        ) {
          throw error;
        }
      }
    }
    if (!handle || !tempPath) {
      throw new Error(
        `Unable to create an atomic temp file for ${targetPath}.`,
      );
    }
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;

    await replaceFileWithRetry(tempPath, targetPath, {
      beforeAttempt: async () => {
        await assertArtifactPathOperationSafe(namespace, tempPath!, {
          targetKind: 'file',
        });
        await assertArtifactPathOperationSafe(namespace, targetPath, {
          targetKind: 'file',
        });
      },
      replace: options.rename,
      retryDelaysMs: options.retryDelaysMs,
    });
  } catch (error) {
    await handle?.close().catch(ignoreError);
    if (tempPath) {
      const cleanupPath = tempPath;
      await assertArtifactPathOperationSafe(namespace, cleanupPath, {
        targetKind: 'file',
      })
        .then(() =>
          options.removeTemp
            ? options.removeTemp(cleanupPath)
            : rm(cleanupPath, { force: true }),
        )
        .catch(ignoreError);
    }
    throw error;
  }
}

export function writeJsonAtomically(
  namespace: LiminaArtifactNamespace,
  targetPath: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const previous = writesByTargetPath.get(targetPath) ?? Promise.resolve();
  const scheduled = previous
    .catch(ignoreError)
    .then(() => performAtomicJsonWrite(namespace, targetPath, value, options));
  const tracked = scheduled.finally(() => {
    if (writesByTargetPath.get(targetPath) === tracked) {
      writesByTargetPath.delete(targetPath);
    }
  });
  writesByTargetPath.set(targetPath, tracked);
  return tracked;
}

export class SerialSnapshotWriterQueue {
  #tail: Promise<void> = Promise.resolve();
  #failure: unknown;

  enqueue(job: () => Promise<void>): Promise<void> {
    const scheduled = this.#tail.then(async () => {
      if (this.#failure !== undefined) {
        throw this.#failure;
      }

      try {
        await job();
      } catch (error) {
        this.#failure = error;
        throw error;
      }
    });

    this.#tail = scheduled.catch(ignoreError);
    return scheduled;
  }

  async flush(): Promise<void> {
    await this.#tail;
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
  }
}
