import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const liminaBinPath = fileURLToPath(
  new URL('../../bin/limina.js', import.meta.url),
);
const defaultTimeout = 60_000;
const forceTerminationDelay = 2000;

export interface RunLiminaOptions {
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  fixtureName: string;
  timeout?: number;
}

export interface RunLiminaResult {
  code: number | null;
  fixtureName: string;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

function waitForTaskkill(pid: number, force: boolean): Promise<void> {
  return new Promise((resolve) => {
    const killer = spawn(
      'taskkill',
      ['/pid', String(pid), '/t', ...(force ? ['/f'] : [])],
      {
        stdio: 'ignore',
        windowsHide: true,
      },
    );

    killer.once('error', () => resolve());
    killer.once('close', () => resolve());
  });
}

async function terminateProcessTree(
  child: ChildProcess,
  force: boolean,
): Promise<void> {
  if (child.pid === undefined) {
    return;
  }

  if (process.platform === 'win32') {
    await waitForTaskkill(child.pid, force);
    return;
  }

  const signal: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';

  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ESRCH'
    ) {
      return;
    }

    child.kill(signal);
  }
}

export function runLimina(options: RunLiminaOptions): Promise<RunLiminaResult> {
  return new Promise((resolve, reject) => {
    const terminationAttempts: Promise<void>[] = [];
    let forceTimer: NodeJS.Timeout | undefined;
    let spawnError: Error | undefined;
    let stderr = '';
    let stdout = '';
    let timedOut = false;

    const child = spawn(process.execPath, [liminaBinPath, ...options.args], {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        CI: 'true',
        FORCE_COLOR: '0',
        ...options.env,
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      spawnError = error;
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminationAttempts.push(terminateProcessTree(child, false));
      forceTimer = setTimeout(() => {
        terminationAttempts.push(terminateProcessTree(child, true));
      }, forceTerminationDelay);
    }, options.timeout ?? defaultTimeout);

    child.once('close', (code, signal) => {
      clearTimeout(timeoutTimer);
      if (forceTimer) {
        clearTimeout(forceTimer);
      }

      Promise.allSettled(terminationAttempts)
        .then(() => {
          child.stdout.destroy();
          child.stderr.destroy();

          if (spawnError) {
            reject(
              new Error(
                `Unable to start Limina for fixture ${options.fixtureName}: ${spawnError.message}`,
              ),
            );
            return;
          }

          resolve({
            code,
            fixtureName: options.fixtureName,
            signal,
            stderr,
            stdout,
            timedOut,
          });
        })
        .catch(reject);
    });
  });
}
