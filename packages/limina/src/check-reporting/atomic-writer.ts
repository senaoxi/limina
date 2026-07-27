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

type WriteJsonAtomicallyArgs = [
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

function createScheduledWrite(options: {
  atomicWriteOptions: AtomicWriteOptions;
  namespace: LiminaArtifactNamespace;
  previous: Promise<void>;
  targetPath: string;
  value: unknown;
}): Promise<void> {
  return options.previous.catch(ignoreError).then(() =>
    performAtomicJsonWrite({
      namespace: options.namespace,
      options: options.atomicWriteOptions,
      targetPath: options.targetPath,
      value: options.value,
    }),
  );
}

export function writeJsonAtomically(
  ...args: WriteJsonAtomicallyArgs
): Promise<void> {
  const [namespace, targetPath, value, suppliedOptions] = args;
  const atomicWriteOptions = suppliedOptions ?? {};
  const scheduled = createScheduledWrite({
    atomicWriteOptions,
    namespace,
    previous: getPreviousWrite(targetPath),
    targetPath,
    value,
  });
  const tracked = scheduled.finally(() =>
    releaseTrackedWrite(targetPath, tracked),
  );
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
