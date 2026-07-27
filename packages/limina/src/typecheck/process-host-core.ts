import type { ChildProcess } from 'node:child_process';
import {
  type CheckerHostRequest,
  type CheckerHostResponse,
  type CheckerHostSpawnMeasurement,
  type CheckerHostSpawnSpec,
  spawnAndMeasure,
} from './host-protocol';
import {
  createCheckerHostMeasurement,
  isChildProcessRunning,
  refChildProcess,
  unrefChildProcess,
} from './process-host-utils';

export type CheckerHostDegradationListener = (reason: string) => void;

interface PendingCheckerSpawn {
  onDegraded?: CheckerHostDegradationListener;
  resolve: (measurement: CheckerHostSpawnMeasurement) => void;
  spec: CheckerHostSpawnSpec;
}

let degradationNoticeSent = false;

export function notifyCheckerHostDegraded(
  reason: string,
  listener: CheckerHostDegradationListener | undefined,
): void {
  if (degradationNoticeSent) {
    return;
  }

  degradationNoticeSent = true;
  listener?.(reason);
}

export function resetCheckerHostDegradationNotice(): void {
  degradationNoticeSent = false;
}

function notifyProtocolMessage(
  listener: ((message: unknown) => void) | undefined,
  message: CheckerHostResponse,
): void {
  if (listener) {
    listener(message);
  }
}

function notifyDeactivated(listener: (() => void) | undefined): void {
  if (listener) {
    listener();
  }
}

export class CheckerProcessHost {
  readonly #child: ChildProcess;
  readonly #onDeactivate: (() => void) | undefined;
  readonly #pending = new Map<number, PendingCheckerSpawn>();
  readonly #pingTimer: NodeJS.Timeout;
  readonly #removeExitHook: () => void;
  #active = true;
  #disposed = false;
  #nextRequestId = 0;

  constructor(
    child: ChildProcess,
    onProtocolMessage?: (message: unknown) => void,
    onDeactivate?: () => void,
  ) {
    this.#child = child;
    this.#onDeactivate = onDeactivate;
    const killHostOnParentExit = (): void => {
      this.#killChild();
    };

    process.once('exit', killHostOnParentExit);
    this.#removeExitHook = () => {
      process.removeListener('exit', killHostOnParentExit);
    };
    this.#pingTimer = setInterval(() => {
      this.#send({ type: 'ping' });
    }, 5000);
    this.#pingTimer.unref();
    child.on('message', (message: CheckerHostResponse) => {
      this.#handleProtocolMessage(message, onProtocolMessage);
    });
    child.on('error', () => {
      this.#deactivate('checker host process failed to start');
    });
    child.on('exit', () => {
      this.#deactivate('checker host process exited unexpectedly');
    });
  }

  get active(): boolean {
    return this.#active;
  }

  dispose(): void {
    this.#disposed = true;
    this.#active = false;
    clearInterval(this.#pingTimer);
    this.#removeExitHook();
    this.#killChild();
  }

  spawnMeasured(
    spec: CheckerHostSpawnSpec,
    onDegraded: CheckerHostDegradationListener | undefined,
  ): Promise<CheckerHostSpawnMeasurement> {
    if (!this.#active) {
      return spawnAndMeasure(spec);
    }

    return new Promise((resolve) => {
      const id = this.#nextRequestId;
      this.#nextRequestId += 1;
      this.#pending.set(id, { onDegraded, resolve, spec });
      this.#updateRefState();
      this.#send({ ...spec, id, type: 'spawn' });
    });
  }

  #handleProtocolMessage(
    message: CheckerHostResponse,
    onProtocolMessage: ((message: unknown) => void) | undefined,
  ): void {
    notifyProtocolMessage(onProtocolMessage, message);
    if (message.type !== 'result') {
      return;
    }

    const pending = this.#pending.get(message.id);
    if (pending === undefined) {
      return;
    }

    this.#pending.delete(message.id);
    this.#updateRefState();
    pending.resolve(createCheckerHostMeasurement(message));
  }

  #isInactiveAndIdle(): boolean {
    return !this.#active && this.#pending.size === 0;
  }

  #deactivate(reason: string): void {
    if (this.#isInactiveAndIdle()) {
      return;
    }

    this.#active = false;
    clearInterval(this.#pingTimer);
    this.#removeExitHook();
    notifyDeactivated(this.#onDeactivate);

    const pending = [...this.#pending.values()];
    this.#pending.clear();
    this.#updateRefState();

    if (this.#disposed) {
      return;
    }

    this.#retryPending(reason, pending);
  }

  #retryPending(reason: string, pending: readonly PendingCheckerSpawn[]): void {
    for (const entry of pending) {
      notifyCheckerHostDegraded(
        `${reason} — pending checkers retried in-process`,
        entry.onDegraded,
      );
      spawnAndMeasure(entry.spec).then(entry.resolve);
    }
  }

  #updateRefState(): void {
    if (this.#pending.size > 0) {
      refChildProcess(this.#child);
      return;
    }

    unrefChildProcess(this.#child);
  }

  #killChild(): void {
    if (isChildProcessRunning(this.#child)) {
      this.#child.kill();
    }
  }

  #send(request: CheckerHostRequest): void {
    try {
      this.#child.send(request);
    } catch {
      this.#deactivate('checker host channel closed unexpectedly');
    }
  }
}
