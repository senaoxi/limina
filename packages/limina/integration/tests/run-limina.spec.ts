import { type ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRunLimina,
  liminaBinPath,
  type RunLiminaOptions,
  type RunLiminaResult,
} from '../helpers/run-limina';

interface FakeChild {
  child: ChildProcess;
  emitClose: (code: number | null, signal: NodeJS.Signals | null) => void;
  emitError: (error: Error) => void;
  stderr: PassThrough;
  stdout: PassThrough;
}

const commandTimeout = 100;
const forceDelay = 20;
const watchdogDelay = 30;
const runOptions: RunLiminaOptions = {
  args: ['--config', '/fixture/limina.config.mts', 'graph', 'prepare'],
  cwd: '/fixture/repo',
  fixtureName: 'stuck-fixture',
  timeout: commandTimeout,
};

function createFakeChild(): FakeChild {
  const processEvents = new PassThrough();
  const stderr = new PassThrough();
  const stdout = new PassThrough();
  const child = Object.assign(processEvents, {
    kill: vi.fn(() => true),
    pid: 4242,
    stderr,
    stdout,
  }) as unknown as ChildProcess;

  return {
    child,
    emitClose: (code, signal) => {
      processEvents.emit('close', code, signal);
    },
    emitError: (error) => {
      processEvents.emit('error', error);
    },
    stderr,
    stdout,
  };
}

function observeSettlement(
  promise: Promise<RunLiminaResult>,
): Promise<
  | { error: Error; kind: 'rejected' }
  | { kind: 'resolved'; value: RunLiminaResult }
> {
  return promise.then(
    (value) => ({ kind: 'resolved' as const, value }),
    (error: unknown) => ({
      error: error instanceof Error ? error : new Error(String(error)),
      kind: 'rejected' as const,
    }),
  );
}

async function reachFinalWatchdog(): Promise<void> {
  await vi.advanceTimersByTimeAsync(commandTimeout);
  await vi.advanceTimersByTimeAsync(forceDelay);
  await vi.advanceTimersByTimeAsync(watchdogDelay);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runLimina bounded completion', () => {
  it('rejects within the final watchdog when the child never closes', async () => {
    const fakeChild = createFakeChild();
    const terminate = vi.fn((_child: ChildProcess, force: boolean) =>
      force
        ? Promise.reject(new Error('forced taskkill failed'))
        : Promise.resolve(),
    );
    const run = createRunLimina({
      finalWatchdogDelay: watchdogDelay,
      forceTerminationDelay: forceDelay,
      spawnChild: () => fakeChild.child,
      terminateProcessTree: terminate,
    });
    fakeChild.stdout.write('captured stdout');
    fakeChild.stderr.write('captured stderr');

    const outcomePromise = observeSettlement(run(runOptions));
    await reachFinalWatchdog();
    const outcome = await outcomePromise;

    expect(terminate).toHaveBeenNthCalledWith(1, fakeChild.child, false);
    expect(terminate).toHaveBeenNthCalledWith(2, fakeChild.child, true);
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.error.message).toContain('fixture: stuck-fixture');
      expect(outcome.error.message).toContain('cwd: /fixture/repo');
      expect(outcome.error.message).toContain(
        'args: ["--config","/fixture/limina.config.mts","graph","prepare"]',
      );
      expect(outcome.error.message).toContain('PID: 4242');
      expect(outcome.error.message).toContain(
        'graceful termination requested: true',
      );
      expect(outcome.error.message).toContain(
        'graceful termination completed: true',
      );
      expect(outcome.error.message).toContain(
        'force termination requested: true',
      );
      expect(outcome.error.message).toContain('force termination failed: true');
      expect(outcome.error.message).toContain('forced taskkill failed');
      expect(outcome.error.message).toContain('captured stdout');
      expect(outcome.error.message).toContain('captured stderr');
    }
  });

  it('does not depend on a termination promise completing', async () => {
    const fakeChild = createFakeChild();
    const neverCompletes = new Promise<void>(() => {});
    const terminate = vi.fn(() => neverCompletes);
    const run = createRunLimina({
      finalWatchdogDelay: watchdogDelay,
      forceTerminationDelay: forceDelay,
      spawnChild: () => fakeChild.child,
      terminateProcessTree: terminate,
    });

    const outcomePromise = observeSettlement(run(runOptions));
    await reachFinalWatchdog();
    const outcome = await outcomePromise;

    expect(terminate).toHaveBeenCalledTimes(2);
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.error.message).toContain(
        'graceful termination completed: false',
      );
      expect(outcome.error.message).toContain(
        'force termination completed: false',
      );
    }
  });

  it('ignores close, error, and termination completion after watchdog settlement', async () => {
    const fakeChild = createFakeChild();
    let completeTermination: (() => void) | undefined;
    const termination = new Promise<void>((resolve) => {
      completeTermination = resolve;
    });
    const run = createRunLimina({
      finalWatchdogDelay: watchdogDelay,
      forceTerminationDelay: forceDelay,
      spawnChild: () => fakeChild.child,
      terminateProcessTree: () => termination,
    });
    const settlement = vi.fn();
    const outcomePromise = observeSettlement(run(runOptions)).then(
      (outcome) => {
        settlement(outcome.kind);
        return outcome;
      },
    );

    await reachFinalWatchdog();
    const outcome = await outcomePromise;
    expect(outcome.kind).toBe('rejected');
    expect(settlement).toHaveBeenCalledTimes(1);

    fakeChild.emitClose(0, null);
    fakeChild.emitError(new Error('late child error'));
    completeTermination?.();
    await vi.runAllTicks();

    expect(settlement).toHaveBeenCalledTimes(1);
  });

  it('returns a timed-out result when the child closes during termination', async () => {
    const fakeChild = createFakeChild();
    const termination = new Promise<void>(() => {});
    const run = createRunLimina({
      finalWatchdogDelay: watchdogDelay,
      forceTerminationDelay: forceDelay,
      spawnChild: () => fakeChild.child,
      terminateProcessTree: () => termination,
    });
    fakeChild.stdout.write('partial stdout');
    fakeChild.stderr.write('partial stderr');

    const resultPromise = run(runOptions);
    await vi.advanceTimersByTimeAsync(commandTimeout);
    fakeChild.emitClose(143, 'SIGTERM');
    const result = await resultPromise;

    expect(result).toEqual({
      args: [liminaBinPath, ...runOptions.args],
      code: 143,
      cwd: runOptions.cwd,
      executable: process.execPath,
      fixtureName: 'stuck-fixture',
      signal: 'SIGTERM',
      stderr: 'partial stderr',
      stdout: 'partial stdout',
      timedOut: true,
    });
  });

  it('settles a normal exit without requesting termination', async () => {
    const fakeChild = createFakeChild();
    const terminate = vi.fn(() => Promise.resolve());
    const run = createRunLimina({
      finalWatchdogDelay: watchdogDelay,
      forceTerminationDelay: forceDelay,
      spawnChild: () => fakeChild.child,
      terminateProcessTree: terminate,
    });

    const resultPromise = run(runOptions);
    fakeChild.emitClose(0, null);
    const result = await resultPromise;
    await vi.advanceTimersByTimeAsync(
      commandTimeout + forceDelay + watchdogDelay,
    );

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(terminate).not.toHaveBeenCalled();
  });
});
