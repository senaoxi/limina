import type { LiminaArtifactNamespace } from '../domain/artifacts/namespace';
import {
  type AtomicWriteOptions,
  performAtomicJsonWrite,
} from './atomic-write-operation';

export {
  replaceFileWithRetry,
  ReplacementDriftError,
  RetryableReplacementValidationIoError,
  TerminalReplacementValidationError,
  type ReplaceFileWithRetryOptions,
} from './atomic-replace';
export type {
  AtomicFileHandle,
  AtomicWriteOptions,
} from './atomic-write-operation';

const writesByTargetPath = new Map<string, Promise<void>>();

type WriteJsonAtomicallyArguments = [
  namespace: LiminaArtifactNamespace,
  targetPath: string,
  value: unknown,
  options?: AtomicWriteOptions,
];

function ignoreError(error: unknown): void {
  // Best-effort cleanup must not replace the primary writer error.
  String(error);
}

function getPreviousWrite(targetPath: string): Promise<void> {
  const previous = writesByTargetPath.get(targetPath);
  return previous === undefined ? Promise.resolve() : previous;
}

function releaseTrackedWrite(targetPath: string, tracked: Promise<void>): void {
  if (writesByTargetPath.get(targetPath) === tracked) {
    writesByTargetPath.delete(targetPath);
  }
}

async function createScheduledWrite(options: {
  atomicWriteOptions: AtomicWriteOptions;
  namespace: LiminaArtifactNamespace;
  previous: Promise<void>;
  targetPath: string;
  value: unknown;
}): Promise<void> {
  try {
    await options.previous;
  } catch (error) {
    ignoreError(error);
  }
  return performAtomicJsonWrite({
    namespace: options.namespace,
    options: options.atomicWriteOptions,
    targetPath: options.targetPath,
    value: options.value,
  });
}

async function trackScheduledWrite(
  scheduled: Promise<void>,
  release: () => void,
): Promise<void> {
  try {
    await scheduled;
  } finally {
    release();
  }
}

export function writeJsonAtomically(
  ...arguments_: WriteJsonAtomicallyArguments
): Promise<void> {
  const [namespace, targetPath, value, suppliedOptions] = arguments_;
  const atomicWriteOptions = suppliedOptions ?? {};
  const scheduled = createScheduledWrite({
    atomicWriteOptions,
    namespace,
    previous: getPreviousWrite(targetPath),
    targetPath,
    value,
  });
  const tracked = trackScheduledWrite(scheduled, () => {
    releaseTrackedWrite(targetPath, tracked);
  });
  writesByTargetPath.set(targetPath, tracked);
  return tracked;
}

export class SerialSnapshotWriterQueue {
  #tail: Promise<void> = Promise.resolve();
  #failure: unknown;

  enqueue(job: () => Promise<void>): Promise<void> {
    const previous = this.#tail;
    const scheduled = (async () => {
      await previous;
      if (this.#failure !== undefined) {
        throw this.#failure;
      }

      try {
        await job();
      } catch (error) {
        this.#failure = error;
        throw error;
      }
    })();

    this.#tail = (async () => {
      try {
        await scheduled;
      } catch (error) {
        ignoreError(error);
      }
    })();
    return scheduled;
  }

  async flush(): Promise<void> {
    await this.#tail;

    if (this.#failure !== undefined) {
      throw this.#failure;
    }
  }
}
