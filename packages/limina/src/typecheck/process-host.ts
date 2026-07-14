import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'pathe';
import {
  type CheckerHostRequest,
  type CheckerHostResponse,
  type CheckerHostSpawnMeasurement,
  type CheckerHostSpawnSpec,
  spawnAndMeasure,
} from './host-protocol';

export type CheckerHostDegradationListener = (reason: string) => void;

interface CheckerHostEntry {
  args: string[];
  command: string;
}

interface PendingCheckerSpawn {
  onDegraded?: CheckerHostDegradationListener;
  resolve: (measurement: CheckerHostSpawnMeasurement) => void;
  spec: CheckerHostSpawnSpec;
}

const requireFromHostClient = createRequire(import.meta.url);

function resolveTsxCliPath(packageDir: string): string | undefined {
  try {
    return requireFromHostClient.resolve('tsx/cli');
  } catch {
    return [
      path.join(packageDir, 'node_modules/tsx/dist/cli.mjs'),
      path.join(packageDir, '../../node_modules/tsx/dist/cli.mjs'),
    ].find((candidate) => existsSync(candidate));
  }
}

function resolveCheckerHostEntry(): CheckerHostEntry | undefined {
  const currentDir = fileURLToPath(new URL('.', import.meta.url));
  const sourceEntries = [
    path.resolve(currentDir, 'host-process.ts'),
    path.resolve(process.cwd(), 'src/typecheck/host-process.ts'),
  ];
  const distEntries = [
    path.resolve(currentDir, 'checker-host-process.js'),
    path.resolve(currentDir, '../checker-host-process.js'),
    path.resolve(process.cwd(), 'dist/checker-host-process.js'),
  ];
  const sourceEntry = sourceEntries.find((candidate) => existsSync(candidate));

  if (sourceEntry) {
    const tsxCliPath = resolveTsxCliPath(
      path.resolve(path.dirname(sourceEntry), '../..'),
    );

    if (!tsxCliPath) {
      return undefined;
    }

    return {
      args: [tsxCliPath, sourceEntry],
      command: process.execPath,
    };
  }

  const distEntry = distEntries.find((candidate) => existsSync(candidate));

  if (distEntry) {
    return {
      args: [distEntry],
      command: process.execPath,
    };
  }

  return undefined;
}

let sharedHost: CheckerProcessHost | undefined;
let sharedHostUnavailable = false;
let degradationNoticeSent = false;

function notifyDegraded(
  reason: string,
  listener: CheckerHostDegradationListener | undefined,
): void {
  if (degradationNoticeSent) {
    return;
  }

  degradationNoticeSent = true;
  listener?.(reason);
}

class CheckerProcessHost {
  readonly #child: ChildProcess;
  readonly #pending = new Map<number, PendingCheckerSpawn>();
  readonly #pingTimer: NodeJS.Timeout;
  readonly #removeExitHook: () => void;
  #active = true;
  #disposed = false;
  #nextRequestId = 0;

  constructor(child: ChildProcess) {
    this.#child = child;
    // The host cannot rely on IPC disconnect alone: in source mode it runs
    // behind a tsx wrapper process that neither exits nor forwards the
    // channel closure when this parent process ends, which would leak the
    // host and keep inherited stdio pipes open. Killing it on parent exit
    // reaches the real host in both modes (tsx forwards signals), and the
    // periodic ping lets the host's own idle watchdog catch parents that
    // died without running exit hooks.
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
      if (message.type !== 'result') {
        return;
      }

      const pending = this.#pending.get(message.id);

      if (!pending) {
        return;
      }

      this.#pending.delete(message.id);
      this.#updateRefState();
      pending.resolve({
        durationMs: message.durationMs,
        ...(message.errorMessage === undefined
          ? {}
          : { error: new Error(message.errorMessage) }),
        status: message.status,
      });
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
      this.#send({
        ...spec,
        id,
        type: 'spawn',
      });
    });
  }

  #deactivate(reason: string): void {
    if (!this.#active && this.#pending.size === 0) {
      return;
    }

    this.#active = false;
    clearInterval(this.#pingTimer);
    this.#removeExitHook();
    sharedHost = undefined;
    sharedHostUnavailable = true;

    const pending = [...this.#pending.values()];

    this.#pending.clear();
    this.#updateRefState();

    if (this.#disposed) {
      return;
    }

    // Checker builds are incremental and idempotent, so pending spawns are
    // retried once in-process instead of surfacing an infrastructure failure
    // as a checker failure. Retried durations fall back to parent-side
    // measurement accuracy.
    for (const entry of pending) {
      notifyDegraded(
        `${reason} — pending checkers retried in-process`,
        entry.onDegraded,
      );
      spawnAndMeasure(entry.spec).then(entry.resolve);
    }
  }

  // An unref'd host never keeps the CLI alive, but while responses are
  // pending the IPC channel may be the only live handle, so it must be
  // ref'd or the parent process could exit before results arrive.
  #updateRefState(): void {
    if (this.#pending.size > 0) {
      this.#child.ref();
      this.#child.channel?.ref();
      return;
    }

    this.#child.unref();
    this.#child.channel?.unref();
  }

  #killChild(): void {
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
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

function resolveSharedCheckerHost(
  onDegraded: CheckerHostDegradationListener | undefined,
): CheckerProcessHost | undefined {
  if (process.env.LIMINA_CHECKER_HOST === 'off') {
    notifyDegraded(
      'LIMINA_CHECKER_HOST=off — durations measured in-process',
      onDegraded,
    );
    return undefined;
  }

  if (sharedHostUnavailable) {
    return undefined;
  }

  if (sharedHost?.active) {
    return sharedHost;
  }

  const entry = resolveCheckerHostEntry();

  if (!entry) {
    sharedHostUnavailable = true;
    notifyDegraded(
      'checker host entry could not be resolved — durations measured in-process',
      onDegraded,
    );
    return undefined;
  }

  const child = spawn(entry.command, entry.args, {
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });

  sharedHost = new CheckerProcessHost(child);

  return sharedHost;
}

/**
 * Runs one checker command with its duration measured inside the shared
 * checker host process, whose event loop stays responsive while the parent
 * CLI runs synchronous analysis work. Falls back to in-process spawning with
 * parent-side measurement when the host is disabled or unavailable.
 */
export async function runCheckerSpawnMeasured(
  spec: CheckerHostSpawnSpec,
  options: { onDegraded?: CheckerHostDegradationListener } = {},
): Promise<CheckerHostSpawnMeasurement> {
  const host = resolveSharedCheckerHost(options.onDegraded);

  if (!host) {
    return spawnAndMeasure(spec);
  }

  return host.spawnMeasured(spec, options.onDegraded);
}

export function disposeCheckerProcessHostForTesting(): void {
  sharedHost?.dispose();
  sharedHost = undefined;
  sharedHostUnavailable = false;
  degradationNoticeSent = false;
}
