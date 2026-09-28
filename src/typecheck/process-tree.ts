import { type ChildProcess, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const FORCE_KILL_DELAY_MS = 500;
const TERMINATION_TIMEOUT_MS = 2000;
const terminatingChildren = new WeakMap<
  ChildProcess,
  Promise<Error | undefined>
>();

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
  return undefined;
}

function runTaskkill(pid: number, force: boolean): void {
  const taskkill = spawn(
    'taskkill',
    ['/pid', String(pid), '/T', ...(force ? ['/F'] : [])],
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
  const deadline = Date.now() + TERMINATION_TIMEOUT_MS;
  const forceTimer = setTimeout(
    () => forceTerminateChildProcessTree(child),
    FORCE_KILL_DELAY_MS,
  );
  gracefullyTerminateChildProcessTree(child);
  try {
    while (isProcessTreeRunning(child)) {
      if (Date.now() >= deadline) {
        return new Error(
          `Checker process tree ${child.pid} did not terminate after escalation.`,
        );
      }
      await delay(20);
    }
    return undefined;
  } finally {
    clearTimeout(forceTimer);
  }
}

export function waitForChildProcessTreeTermination(
  child: ChildProcess,
): Promise<Error | undefined> {
  return Promise.resolve(terminatingChildren.get(child));
}

export function terminateChildProcessTree(child: ChildProcess): void {
  if (terminatingChildren.has(child)) return;
  if (!isProcessTreeRunning(child)) return;
  terminatingChildren.set(child, terminateAndWait(child));
}
