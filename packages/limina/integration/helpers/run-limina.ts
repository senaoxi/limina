import {
  type ChildProcess,
  spawn,
  type SpawnOptions,
} from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const builtBinPath = fileURLToPath(
  new URL('../../dist/bin/limina.js', import.meta.url),
);
const sourceBinPath = fileURLToPath(
  new URL('../../bin/limina.js', import.meta.url),
);

/**
 * Integration tests spawn the CLI as a real subprocess hundreds of times, so
 * the per-spawn cost dominates the whole suite. The source `bin/limina.js`
 * prefers `src/cli.ts` via tsx, which re-transpiles the entire CLI tree and
 * incurs a second process spawn on every invocation — several times slower on
 * Windows, where it inflates the suite from minutes to tens of minutes. When a
 * build is present (always the case in CI before this step runs) the built
 * shim imports `dist/cli.js` in-process with no tsx and no double spawn, so we
 * prefer it and only fall back to the source entry for un-built local runs.
 */
export const liminaBinPath = existsSync(builtBinPath)
  ? builtBinPath
  : sourceBinPath;
const defaultTimeout = 60_000;
const forceTerminationDelay = 2000;
const finalWatchdogDelay = 5000;

export interface RunLiminaOptions {
  args: readonly string[];
  cwd: string;
  entry?: {
    readonly args: readonly string[];
    readonly executable: string;
  };
  env?: NodeJS.ProcessEnv;
  fixtureName: string;
  inheritParentEnv?: boolean;
  timeout?: number;
}

export interface RunLiminaResult {
  args: readonly string[];
  code: number | null;
  cwd: string;
  executable: string;
  fixtureName: string;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

export interface LiminaSpawnSpec {
  readonly args: readonly string[];
  readonly executable: string;
  readonly options: SpawnOptions;
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

export function createLiminaSpawnSpec(
  options: RunLiminaOptions,
): LiminaSpawnSpec {
  const entry = options.entry ?? {
    args: [liminaBinPath],
    executable: process.execPath,
  };
  return {
    args: [...entry.args, ...options.args],
    executable: entry.executable,
    options: {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      env: {
        ...(options.inheritParentEnv === false ? {} : process.env),
        CI: 'true',
        FORCE_COLOR: '0',
        ...options.env,
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  };
}

function spawnLiminaChild(options: RunLiminaOptions): ChildProcess {
  const spec = createLiminaSpawnSpec(options);
  return spawn(spec.executable, [...spec.args], spec.options);
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
  args: readonly string[];
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
        const spec = createLiminaSpawnSpec(options);
        resolve({
          args: spec.args,
          code,
          cwd: options.cwd,
          executable: spec.executable,
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
