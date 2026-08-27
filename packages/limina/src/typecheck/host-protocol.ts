import { type ChildProcess, spawn } from 'node:child_process';
import { terminateChildProcessTree } from './process-tree';

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
  error?: Error;
  status: number;
}

export type CheckerHostRequest =
  | (CheckerHostSpawnSpec & {
      id: number;
      type: 'spawn';
    })
  | { id: number; type: 'cancel' }
  | { type: 'ping' };

export type CheckerHostResponse =
  | { type: 'ready' }
  | {
      durationMs: number;
      errorMessage?: string;
      id: number;
      status: number;
      type: 'result';
    };

function createAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(
    signal.reason === undefined
      ? 'Checker target cancelled.'
      : String(signal.reason),
  );
  error.name = 'AbortError';
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
  return signal === undefined ? false : signal.aborted;
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
 * Spawns one checker command and measures its lifetime from spawn until the
 * close/error event. The measurement is only accurate when the surrounding
 * event loop stays responsive while the child runs, so the checker host
 * process is the primary caller; the parent CLI process uses it directly only
 * as the degraded in-process fallback.
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
    let settled = false;
    const startedAt = performance.now();
    const finalize = (measurement: CheckerHostSpawnMeasurement): void => {
      if (settled) {
        return;
      }

      settled = true;
      removeAbortListener(signal, handleAbort);
      resolve(measurement);
    };

    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      detached: process.platform !== 'win32',
      shell: spec.shell,
      stdio: spec.stdio,
    });

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
          durationMs: performance.now() - startedAt,
          error,
          status: 1,
        },
      );
    });

    child.on('close', (code) => {
      finalize(
        cancelledMeasurement ?? {
          durationMs: performance.now() - startedAt,
          status: code ?? 1,
        },
      );
    });
  });
}
