import { type ChildProcess, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const FORCE_KILL_DELAY_MS = 500;
const TERMINATION_TIMEOUT_MS = 2000;
const terminatingChildren = new WeakMap<
  ChildProcess,
  Promise<Error | undefined>
>();

const ownedChildren = new Set<ChildProcess>();

function killOwnedGroupsOnExit(): void {
  for (const child of ownedChildren) {
    if (child.pid === undefined) continue;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // The owned group may already have exited; shutdown cannot await cleanup.
    }
  }
}

type OwnedSignal = 'SIGINT' | 'SIGTERM';
const signalHandlers = {
  SIGINT: () => handleOwnedSignal('SIGINT'),
  SIGTERM: () => handleOwnedSignal('SIGTERM'),
};

function handleOwnedSignal(signal: OwnedSignal): void {
  const ownHandler = signalHandlers[signal];
  if (process.listeners(signal).some((listener) => listener !== ownHandler))
    return;
  killOwnedGroupsOnExit();
  process.removeListener(signal, ownHandler);
  process.kill(process.pid, signal);
}

function keepOwnedSignalHandlerFirst(
  event: string | symbol,
  listener: (...arguments_: unknown[]) => void,
): void {
  if (event !== 'SIGINT' && event !== 'SIGTERM') return;
  const ownHandler = signalHandlers[event];
  if (listener === ownHandler) return;
  // Native signal callbacks run after this turn's microtasks. Observing custom
  // once listeners before they remove themselves preserves their ownership.
  queueMicrotask(() => {
    if (ownedChildren.size === 0) return;
    process.removeListener(event, ownHandler);
    process.prependListener(event, ownHandler);
  });
}

function installOwnedGroupHooks(): void {
  process.once('exit', killOwnedGroupsOnExit);
  process.on('newListener', keepOwnedSignalHandlerFirst);
  process.prependListener('SIGINT', signalHandlers.SIGINT);
  process.prependListener('SIGTERM', signalHandlers.SIGTERM);
}

function removeOwnedGroupHooks(): void {
  process.removeListener('exit', killOwnedGroupsOnExit);
  process.removeListener('newListener', keepOwnedSignalHandlerFirst);
  process.removeListener('SIGINT', signalHandlers.SIGINT);
  process.removeListener('SIGTERM', signalHandlers.SIGTERM);
}

/**
 * Hold the actual POSIX group identity through cleanup, including ordinary exit.
 * A borrowed group member must never register here.
 */
export function ownChildProcessTree(child: ChildProcess): () => void {
  if (process.platform === 'win32')
    return () => {
      // Windows has no inherited POSIX process-group identity to release.
    };
  if (ownedChildren.size === 0) installOwnedGroupHooks();
  ownedChildren.add(child);
  return () => {
    ownedChildren.delete(child);
    if (ownedChildren.size === 0) removeOwnedGroupHooks();
  };
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function isPosixProcessGroupRunning(child: ChildProcess): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function isProcessTreeRunning(child: ChildProcess): boolean {
  return process.platform === 'win32'
    ? isRunning(child)
    : isPosixProcessGroupRunning(child);
}

function ignoreTaskkillError(): undefined {
  // Child termination is best-effort; its bounded liveness loop owns failure reporting.
}

function runTaskkill(pid: number, isForce: boolean): void {
  const taskkill = spawn(
    'taskkill',
    ['/pid', String(pid), '/T', ...(isForce ? ['/F'] : [])],
    { stdio: 'ignore', windowsHide: true },
  );
  taskkill.on('error', ignoreTaskkillError);
  taskkill.unref();
}

function handlePosixSignalFailure(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (!isRunning(child)) return;
  child.kill(signal);
}

function signalPosixProcessGroup(
  child: ChildProcess,
  pid: number,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-pid, signal);
  } catch {
    handlePosixSignalFailure(child, signal);
  }
}

function getChildPid(child: ChildProcess): number | null {
  return child.pid ?? null;
}

function terminateForPlatform(options: {
  child: ChildProcess;
  force: boolean;
  pid: number;
}): void {
  if (process.platform === 'win32') {
    runTaskkill(options.pid, options.force);
    return;
  }
  signalPosixProcessGroup(
    options.child,
    options.pid,
    options.force ? 'SIGKILL' : 'SIGTERM',
  );
}

function forceTerminateChildProcessTree(child: ChildProcess): void {
  if (!isProcessTreeRunning(child)) return;
  const pid = getChildPid(child);
  if (pid === null) return;
  terminateForPlatform({ child, force: true, pid });
}

function gracefullyTerminateChildProcessTree(child: ChildProcess): void {
  const pid = getChildPid(child);
  if (pid === null) return;
  terminateForPlatform({ child, force: false, pid });
}

async function terminateAndWait(
  child: ChildProcess,
): Promise<Error | undefined> {
  const forceAt = performance.now() + FORCE_KILL_DELAY_MS;
  let terminationDeadline: number | undefined;
  gracefullyTerminateChildProcessTree(child);
  while (isProcessTreeRunning(child)) {
    const now = performance.now();
    if (terminationDeadline === undefined && now >= forceAt) {
      forceTerminateChildProcessTree(child);
      // An overdue poll must escalate before it can time out. Event-loop stalls
      // cannot consume the force-wait budget before SIGKILL was actually sent.
      terminationDeadline = now + TERMINATION_TIMEOUT_MS - FORCE_KILL_DELAY_MS;
    } else if (
      terminationDeadline !== undefined &&
      now >= terminationDeadline
    ) {
      return new Error(
        `Checker process tree ${child.pid} did not terminate after escalation.`,
      );
    }
    await delay(20);
  }
  return undefined;
}

export function waitForChildProcessTreeTermination(
  child: ChildProcess,
): Promise<Error | undefined> {
  return Promise.resolve(terminatingChildren.get(child));
}

export function terminateChildProcessTree(child: ChildProcess): void {
  if (terminatingChildren.has(child) || !isProcessTreeRunning(child)) return;
  terminatingChildren.set(child, terminateAndWait(child));
}

/**
Dedicated detached POSIX supervisor only: retain the force timer until it kills this group.
*/
export function terminateSupervisorProcessGroup(): void {
  // The supervisor itself keeps the group alive, so a liveness poll cannot
  // finish early. Its final SIGKILL includes itself and all inherited children.
  setTimeout(() => process.kill(-process.pid, 'SIGKILL'), FORCE_KILL_DELAY_MS);
  process.kill(-process.pid, 'SIGTERM');
}
