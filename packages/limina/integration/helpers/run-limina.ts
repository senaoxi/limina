import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const liminaBinPath = fileURLToPath(
  new URL('../../bin/limina.js', import.meta.url),
);
const defaultTimeout = 60_000;
const forceTerminationDelay = 2000;
const finalWatchdogDelay = 5000;

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

interface TerminationStatus {
  completed: boolean;
  failure?: string;
  requested: boolean;
}

interface RunLiminaDependencies {
  finalWatchdogDelay: number;
  forceTerminationDelay: number;
  spawnChild: (options: RunLiminaOptions) => ChildProcess;
  terminateProcessTree: (child: ChildProcess, force: boolean) => Promise<void>;
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

function spawnLiminaChild(options: RunLiminaOptions): ChildProcess {
  return spawn(process.execPath, [liminaBinPath, ...options.args], {
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
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTerminationStatus(
  label: 'force' | 'graceful',
  status: TerminationStatus,
): string[] {
  return [
    `${label} termination requested: ${String(status.requested)}`,
    `${label} termination completed: ${String(status.completed)}`,
    `${label} termination failed: ${String(status.failure !== undefined)}`,
    ...(status.failure === undefined
      ? []
      : [`${label} termination failure: ${status.failure}`]),
  ];
}

function formatFinalWatchdogError(options: {
  args: string[];
  cwd: string;
  fixtureName: string;
  force: TerminationStatus;
  graceful: TerminationStatus;
  pid: number | undefined;
  stderr: string;
  stdout: string;
}): Error {
  return new Error(
    [
      'Limina integration runner exceeded its final completion watchdog.',
      `fixture: ${options.fixtureName}`,
      `cwd: ${options.cwd}`,
      `args: ${JSON.stringify(options.args)}`,
      `PID: ${String(options.pid ?? 'unavailable')}`,
      ...formatTerminationStatus('graceful', options.graceful),
      ...formatTerminationStatus('force', options.force),
      `stdout:\n${options.stdout}`,
      `stderr:\n${options.stderr}`,
    ].join('\n'),
  );
}

export function createRunLimina(
  overrides: Partial<RunLiminaDependencies> = {},
): (options: RunLiminaOptions) => Promise<RunLiminaResult> {
  const dependencies: RunLiminaDependencies = {
    finalWatchdogDelay,
    forceTerminationDelay,
    spawnChild: spawnLiminaChild,
    terminateProcessTree,
    ...overrides,
  };

  return (options: RunLiminaOptions): Promise<RunLiminaResult> =>
    runLiminaWithDependencies(options, dependencies);
}

function runLiminaWithDependencies(
  options: RunLiminaOptions,
  dependencies: RunLiminaDependencies,
): Promise<RunLiminaResult> {
  return new Promise((resolve, reject) => {
    const forceStatus: TerminationStatus = {
      completed: false,
      requested: false,
    };
    const gracefulStatus: TerminationStatus = {
      completed: false,
      requested: false,
    };
    let finalWatchdogTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let settled = false;
    let stderr = '';
    let stdout = '';
    let timedOut = false;

    let child: ChildProcess;
    try {
      child = dependencies.spawnChild(options);
    } catch (error) {
      reject(
        new Error(
          `Unable to start Limina for fixture ${options.fixtureName}: ${formatUnknownError(error)}`,
        ),
      );
      return;
    }

    if (!child.stdout || !child.stderr) {
      reject(
        new Error(
          `Unable to capture Limina output for fixture ${options.fixtureName}.`,
        ),
      );
      return;
    }

    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;

    const clearTimers = (): void => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (forceTimer) {
        clearTimeout(forceTimer);
      }
      if (finalWatchdogTimer) {
        clearTimeout(finalWatchdogTimer);
      }
    };

    const onStdout = (chunk: string): void => {
      stdout += chunk;
    };
    const onStderr = (chunk: string): void => {
      stderr += chunk;
    };

    const settle = (complete: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimers();
      stdoutStream.off('data', onStdout);
      stderrStream.off('data', onStderr);
      stdoutStream.destroy();
      stderrStream.destroy();
      complete();
    };

    const requestTermination = (
      status: TerminationStatus,
      force: boolean,
    ): void => {
      status.requested = true;

      Promise.resolve()
        .then(() => dependencies.terminateProcessTree(child, force))
        .then(
          () => {
            if (!settled) {
              status.completed = true;
            }
          },
          (error: unknown) => {
            if (!settled) {
              status.failure = formatUnknownError(error);
            }
          },
        );
    };

    stdoutStream.setEncoding('utf8');
    stderrStream.setEncoding('utf8');
    stdoutStream.on('data', onStdout);
    stderrStream.on('data', onStderr);
    child.on('error', (error) => {
      settle(() => {
        reject(
          new Error(
            `Unable to start Limina for fixture ${options.fixtureName}: ${error.message}`,
          ),
        );
      });
    });

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      requestTermination(gracefulStatus, false);
      forceTimer = setTimeout(() => {
        requestTermination(forceStatus, true);
        finalWatchdogTimer = setTimeout(() => {
          settle(() => {
            reject(
              formatFinalWatchdogError({
                args: options.args,
                cwd: options.cwd,
                fixtureName: options.fixtureName,
                force: forceStatus,
                graceful: gracefulStatus,
                pid: child.pid,
                stderr,
                stdout,
              }),
            );
          });
        }, dependencies.finalWatchdogDelay);
      }, dependencies.forceTerminationDelay);
    }, options.timeout ?? defaultTimeout);

    child.on('close', (code, signal) => {
      settle(() => {
        resolve({
          code,
          fixtureName: options.fixtureName,
          signal,
          stderr,
          stdout,
          timedOut,
        });
      });
    });
  });
}

export const runLimina = createRunLimina();
