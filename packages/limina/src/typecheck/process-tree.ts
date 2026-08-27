import { type ChildProcess, spawn } from 'node:child_process';

const FORCE_KILL_DELAY_MS = 500;
const terminatingChildren = new WeakSet<ChildProcess>();

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
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
  if (!isRunning(child)) return;
  const pid = getChildPid(child);
  if (pid === null) return;
  terminateForPlatform({ child, force: true, pid });
}

function gracefullyTerminateChildProcessTree(child: ChildProcess): void {
  const pid = getChildPid(child);
  if (pid === null) return;
  terminateForPlatform({ child, force: false, pid });
}

export function terminateChildProcessTree(child: ChildProcess): void {
  if (!isRunning(child)) return;
  if (terminatingChildren.has(child)) return;
  terminatingChildren.add(child);

  const forceTimer = setTimeout(
    () => forceTerminateChildProcessTree(child),
    FORCE_KILL_DELAY_MS,
  );
  forceTimer.unref();
  child.once('close', () => clearTimeout(forceTimer));
  gracefullyTerminateChildProcessTree(child);
}
