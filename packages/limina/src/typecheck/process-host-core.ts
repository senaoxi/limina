import type { ChildProcess } from 'node:child_process';
import {
  type CheckerHostResponse,
  type CheckerHostSpawnMeasurement,
  type CheckerHostSpawnSpec,
  createCancelledCheckerMeasurement,
  isCheckerHostResponse,
  spawnAndMeasure,
} from './host-protocol';
import {
  ownChildProcessTree,
  terminateChildProcessTree,
  waitForChildProcessTreeTermination,
} from './process-tree';

export type CheckerHostDegradationListener = (reason: string) => void;

const state = { isDegradationNoticeSent: false };

export function notifyCheckerHostDegraded(
  reason: string,
  listener: CheckerHostDegradationListener | undefined,
): void {
  if (state.isDegradationNoticeSent) return;
  state.isDegradationNoticeSent = true;
  listener?.(reason);
}

export function resetCheckerHostDegradationNotice(): void {
  state.isDegradationNoticeSent = false;
}

type HostResult = Extract<CheckerHostResponse, { type: 'result' }>;
type HostPhase = 'awaiting-ready' | 'dispatched' | 'settling' | 'settled';

/**
One already-owned process group, with no retry after a launch attempt.
*/
export class CheckerProcessHost {
  readonly #child: ChildProcess;
  readonly #releaseOwnership: () => void;
  readonly #onProtocolMessage: ((message: unknown) => void) | undefined;
  #cancel: (() => void) | undefined;
  #completion: Promise<CheckerHostSpawnMeasurement> | undefined;

  constructor(
    child: ChildProcess,
    onProtocolMessage?: (message: unknown) => void,
  ) {
    this.#child = child;
    this.#releaseOwnership = ownChildProcessTree(child);
    this.#onProtocolMessage = onProtocolMessage;
  }

  #run(
    spec: CheckerHostSpawnSpec,
    onDegraded: CheckerHostDegradationListener | undefined,
    externalSignal: AbortSignal | undefined,
    startedAt: number,
  ): Promise<CheckerHostSpawnMeasurement> {
    const child = this.#child;
    const controller = new AbortController();
    const signal =
      externalSignal === undefined
        ? controller.signal
        : AbortSignal.any([externalSignal, controller.signal]);
    let phase: HostPhase = 'awaiting-ready';
    let hasDispatched = false;
    let result: HostResult | undefined;
    let cancelled: CheckerHostSpawnMeasurement | undefined;
    let timer: NodeJS.Timeout;
    const closed = new Promise<void>((resolve) => child.once('close', resolve));

    return new Promise((resolve) => {
      const finish = async (error?: Error): Promise<void> => {
        if (phase === 'settling' || phase === 'settled') return;
        phase = 'settling';
        clearTimeout(timer);
        terminateChildProcessTree(child);
        const cleanupError = await waitForChildProcessTreeTermination(child);
        if (cleanupError === undefined) await closed;
        this.#releaseOwnership();
        let measurement: CheckerHostSpawnMeasurement;
        if (signal?.aborted)
          cancelled ??= createCancelledCheckerMeasurement(signal);
        if (cleanupError !== undefined) {
          measurement = { status: 1, error: cleanupError, durationMs: 0 };
        } else if (cancelled !== undefined) {
          measurement = {
            ...cancelled,
            ...(result !== undefined && {
              commandDurationMs: result.commandDurationMs,
            }),
          };
        } else if (!hasDispatched) {
          notifyCheckerHostDegraded(
            `${error?.message ?? 'checker supervisor unavailable'} — executing directly before dispatch`,
            onDegraded,
          );
          // Cleanup can yield. Cancellation must be checked again by the direct owner.
          try {
            measurement = await spawnAndMeasure(spec, { signal });
          } catch (error) {
            measurement = {
              status: 1,
              durationMs: 0,
              error: error instanceof Error ? error : new Error(String(error)),
            };
          }
        } else if (error !== undefined || result === undefined) {
          measurement = {
            status: 1,
            durationMs: 0,
            error:
              error ??
              new Error(
                'Checker supervisor exited without a result; execution status is unknown.',
              ),
          };
        } else {
          measurement = {
            status: result.status,
            durationMs: 0,
            commandDurationMs: result.commandDurationMs,
            ...(result.errorMessage !== undefined && {
              error: new Error(result.errorMessage),
            }),
          };
        }
        signal?.removeEventListener('abort', handleAbort);
        this.#cancel = undefined;
        phase = 'settled';
        resolve({ ...measurement, durationMs: performance.now() - startedAt });
      };
      const fail = (reason: string): void => {
        finish(new Error(reason));
      };
      const handleAbort = (): void => {
        cancelled ??= createCancelledCheckerMeasurement(signal!);
        finish();
      };
      this.#cancel = () => {
        controller.abort(new Error('Checker supervisor disposed.'));
      };
      child.on('message', (message: unknown) => {
        this.#onProtocolMessage?.(message);
        if (phase === 'settling' || phase === 'settled') return;
        if (!isCheckerHostResponse(message)) {
          fail('Checker supervisor sent an invalid protocol message.');
        } else if (phase === 'awaiting-ready' && message.type === 'ready') {
          clearTimeout(timer);
          phase = 'dispatched';
          // Even a thrown send can follow partial transport delivery. Never replay.
          hasDispatched = true;
          try {
            child.send({ ...spec, type: 'spawn' }, (error) => {
              if (error !== null)
                fail(
                  `Checker supervisor launch transport failed: ${error.message}`,
                );
            });
          } catch (error) {
            fail(
              `Checker supervisor launch transport failed: ${String(error)}`,
            );
          }
        } else if (
          phase === 'dispatched' &&
          result === undefined &&
          message.type === 'result'
        ) {
          result = message;
          // A well-behaved supervisor exits after sending. A stuck one still has
          // a bounded cleanup path; receipt alone never releases the target.
          timer = setTimeout(() => {
            finish();
          }, 1000);
        } else {
          fail('Checker supervisor sent an unexpected protocol message.');
        }
      });
      child.once('error', (error) => {
        finish(error);
      });
      child.once('close', () => {
        finish();
      });
      child.once('disconnect', () => {
        if (result === undefined)
          fail(
            'Checker supervisor channel closed before a result; execution status is unknown.',
          );
      });
      timer = setTimeout(
        () => fail('Checker supervisor did not become ready.'),
        10_000,
      );
      signal?.addEventListener('abort', handleAbort, { once: true });
      if (signal?.aborted) handleAbort();
    });
  }
  async dispose(): Promise<void> {
    this.#cancel?.();
    await this.#completion;
  }

  spawnMeasured(
    spec: CheckerHostSpawnSpec,
    onDegraded: CheckerHostDegradationListener | undefined,
    signal?: AbortSignal,
    startedAt: number = performance.now(),
  ): Promise<CheckerHostSpawnMeasurement> {
    if (this.#completion !== undefined)
      throw new Error('Checker supervisor already has a request.');
    this.#completion = this.#run(spec, onDegraded, signal, startedAt);
    return this.#completion;
  }
}
