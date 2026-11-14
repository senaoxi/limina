import { type ChildProcess, spawn } from 'node:child_process';
import {
  ownChildProcessTree,
  terminateChildProcessTree,
  waitForChildProcessTreeTermination,
} from './process-tree';

export interface CheckerHostSpawnSpec {
  args: string[];
  command: string;
  cwd: string;
  env: Record<string, string | undefined>;
  shell: boolean;
  stdio: 'ignore' | 'inherit';
}

export interface CheckerHostSpawnMeasurement {
  durationMs: number;
  commandDurationMs?: number;
  error?: Error;
  status: number;
}

export type CheckerHostRequest = CheckerHostSpawnSpec & { type: 'spawn' };

export type CheckerHostResponse =
  | { type: 'ready' }
  | {
      commandDurationMs: number;
      errorMessage?: string;
      status: number;
      type: 'result';
    };

export function isCheckerHostResponse(
  value: unknown,
): value is CheckerHostResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    (value.type === 'ready' ||
      (value.type === 'result' &&
        'commandDurationMs' in value &&
        typeof value.commandDurationMs === 'number' &&
        Number.isFinite(value.commandDurationMs) &&
        value.commandDurationMs >= 0 &&
        'status' in value &&
        typeof value.status === 'number' &&
        Number.isSafeInteger(value.status) &&
        value.status >= 0 &&
        value.status <= 255 &&
        (!('errorMessage' in value) || typeof value.errorMessage === 'string')))
  );
}

/**
Observe a borrowed group member without taking ownership of cleanup.
The main process and the supervisor's lifecycle handlers manage group cleanup.
*/
export function spawnInheritedChecker(
  spec: CheckerHostSpawnSpec,
): Promise<Extract<CheckerHostResponse, { type: 'result' }>> {
  const startedAt = performance.now();
  return new Promise((resolve) => {
    const finish = (status: number, error?: Error): void =>
      resolve({
        type: 'result',
        status,
        commandDurationMs: performance.now() - startedAt,
        ...(error !== undefined && { errorMessage: error.message }),
      });
    try {
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        detached: false,
        shell: spec.shell,
        stdio: spec.stdio,
      });
      child.once('error', (error) => finish(1, error));
      child.once('close', (code) => finish(code ?? 1));
    } catch (error) {
      finish(1, error instanceof Error ? error : new Error(String(error)));
    }
  });
}

class CheckerAbortError extends Error {
  override name = 'AbortError';
}

function createAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new CheckerAbortError(
    signal.reason === undefined
      ? 'Checker target cancelled.'
      : String(signal.reason),
  );
  return error;
}

export function createCancelledCheckerMeasurement(
  signal: AbortSignal,
): CheckerHostSpawnMeasurement {
  return {
    durationMs: 0,
    error: createAbortError(signal),
    status: 1,
  };
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

function removeAbortListener(
  signal: AbortSignal | undefined,
  listener: () => void,
): void {
  if (signal !== undefined) signal.removeEventListener('abort', listener);
}

function notifyChild(
  listener: ((child: ChildProcess) => void) | undefined,
  child: ChildProcess,
): void {
  if (listener !== undefined) listener(child);
}

/**
Main-owned direct execution, measured through owned process-tree cleanup.
*/
export function spawnAndMeasure(
  spec: CheckerHostSpawnSpec,
  options: {
    onChild?: (child: ChildProcess) => void;
    signal?: AbortSignal;
  } = {},
): Promise<CheckerHostSpawnMeasurement> {
  const signal = options.signal;
  if (isSignalAborted(signal)) {
    return Promise.resolve(createCancelledCheckerMeasurement(signal!));
  }
  return new Promise((resolve) => {
    let cancelledMeasurement: CheckerHostSpawnMeasurement | undefined;
    let isSettled = false;
    const startedAt = performance.now();
    const finalize = (
      measurement: Omit<CheckerHostSpawnMeasurement, 'durationMs'>,
    ): void => {
      if (isSettled) {
        return;
      }

      isSettled = true;
      removeAbortListener(signal, handleAbort);
      releaseOwnership();
      resolve({ ...measurement, durationMs: performance.now() - startedAt });
    };

    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      detached: process.platform !== 'win32',
      shell: spec.shell,
      stdio: spec.stdio,
    });

    const releaseOwnership = ownChildProcessTree(child);
    notifyChild(options.onChild, child);

    const handleAbort = (): void => {
      cancelledMeasurement ??= createCancelledCheckerMeasurement(signal!);
      terminateChildProcessTree(child);
    };
    if (signal !== undefined) {
      signal.addEventListener('abort', handleAbort, { once: true });
      if (signal.aborted) handleAbort();
    }

    child.on('error', (error) => {
      finalize(
        cancelledMeasurement ?? {
          error,
          status: 1,
        },
      );
    });

    child.on('close', (code) => {
      const measurement = cancelledMeasurement ?? {
        status: code ?? 1,
      };
      // Closing the leader does not end an owned POSIX process group.
      terminateChildProcessTree(child);
      const termination = waitForChildProcessTreeTermination(child);
      (async () => {
        const error = await termination;
        finalize(
          error === undefined
            ? measurement
            : { ...measurement, error, status: 1 },
        );
      })();
    });
  });
}
