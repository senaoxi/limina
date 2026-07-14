import type { ResolvedLiminaConfig } from '#config/runner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runBuildTargets } from '../typecheck/build-plan';
import { disposeCheckerProcessHostForTesting } from '../typecheck/process-host';
import {
  createCheckerTargetId,
  createDefaultRunner,
  type TypecheckRunnerResult,
  type TypecheckTarget,
} from '../typecheck/targets';

function createSleepTarget(sleepMs: number, name: string): TypecheckTarget {
  return {
    args: ['-e', `setTimeout(() => process.exit(0), ${sleepMs});`],
    command: process.execPath,
    configPath: `/virtual/${name}/tsconfig.json`,
    cwd: process.cwd(),
    id: createCheckerTargetId(['test', name]),
  };
}

function createPoolConfig(): ResolvedLiminaConfig {
  return {
    configPath: '/virtual/limina.config.mjs',
    execution: { checkerBuild: 2 },
    rootDir: '/virtual',
  };
}

function blockMainThread(durationMs: number): void {
  const blockUntil = performance.now() + durationMs;

  while (performance.now() < blockUntil) {
    // Deliberately spin to simulate synchronous analysis work on the
    // main thread while checker child processes are running.
  }
}

async function waitForMacrotasks(durationMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

afterEach(() => {
  delete process.env.LIMINA_CHECKER_HOST;
  delete process.env.LIMINA_CHECKER_HOST_TEST_CRASH;
  disposeCheckerProcessHostForTesting();
});

describe('createDefaultRunner duration measurement', () => {
  it('measures checker durations independently of main-thread blocking', async () => {
    const runner = createDefaultRunner({ stdio: 'ignore' });
    const shortPromise = Promise.resolve(
      runner(createSleepTarget(150, 'short')),
    );
    const longPromise = Promise.resolve(runner(createSleepTarget(600, 'long')));

    // Let both spawn requests reach the host before blocking the loop.
    await waitForMacrotasks(50);
    blockMainThread(900);

    const [shortResult, longResult] = await Promise.all([
      shortPromise,
      longPromise,
    ]);

    expect(shortResult.status).toBe(0);
    expect(longResult.status).toBe(0);
    expect(shortResult.durationMs).toBeDefined();
    expect(longResult.durationMs).toBeDefined();
    // Without unblocked measurement both close events are observed together
    // after the block and each duration inflates to >=900ms.
    expect(shortResult.durationMs!).toBeLessThan(450);
    expect(longResult.durationMs!).toBeGreaterThan(400);
    expect(longResult.durationMs!).toBeLessThan(1500);
    expect(longResult.durationMs! - shortResult.durationMs!).toBeGreaterThan(
      250,
    );
  });

  it('propagates spawn errors with a measured duration', async () => {
    const runner = createDefaultRunner({ stdio: 'ignore' });

    const result = await runner({
      args: [],
      command: 'limina-missing-command-xyz',
      configPath: '/virtual/missing/tsconfig.json',
      cwd: process.cwd(),
      id: createCheckerTargetId(['test', 'missing']),
    });

    expect(result.status).toBe(1);
    expect(result.error?.message).toContain('ENOENT');
    expect(result.durationMs).toBeDefined();
  });

  it('runs inline with a single degradation notice when LIMINA_CHECKER_HOST=off', async () => {
    process.env.LIMINA_CHECKER_HOST = 'off';

    const onDegraded = vi.fn();
    const runner = createDefaultRunner({ onDegraded, stdio: 'ignore' });

    const firstResult = await runner(createSleepTarget(60, 'off-first'));
    const secondResult = await runner(createSleepTarget(60, 'off-second'));

    expect(firstResult.status).toBe(0);
    expect(secondResult.status).toBe(0);
    expect(firstResult.durationMs).toBeGreaterThan(0);
    expect(secondResult.durationMs).toBeGreaterThan(0);
    expect(onDegraded).toHaveBeenCalledTimes(1);
  });

  it('retries pending spawns inline when the host process dies', async () => {
    process.env.LIMINA_CHECKER_HOST_TEST_CRASH = '1';

    const onDegraded = vi.fn();
    const runner = createDefaultRunner({ onDegraded, stdio: 'ignore' });

    const crashedResult = await runner(createSleepTarget(120, 'crash-first'));

    expect(crashedResult.status).toBe(0);
    expect(crashedResult.durationMs).toBeGreaterThan(0);
    expect(onDegraded).toHaveBeenCalledTimes(1);

    const followUpResult = await runner(createSleepTarget(30, 'crash-second'));

    expect(followUpResult.status).toBe(0);
    expect(followUpResult.durationMs).toBeGreaterThan(0);
    expect(onDegraded).toHaveBeenCalledTimes(1);
  });
});

describe('runBuildTargets duration reporting', () => {
  it('prefers runner-reported durationMs over the pool wall-clock measurement', async () => {
    const target = createSleepTarget(0, 'reported');
    const runner = async (): Promise<TypecheckRunnerResult> => {
      await waitForMacrotasks(40);

      return {
        configPath: target.configPath,
        durationMs: 123,
        status: 0,
      };
    };

    const results = await runBuildTargets([target], [], runner, {
      config: createPoolConfig(),
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.durationMs).toBe(123);
  });

  it('falls back to pool wall-clock measurement when the runner reports no duration', async () => {
    const target = createSleepTarget(0, 'unreported');
    const runner = async (): Promise<TypecheckRunnerResult> => {
      await waitForMacrotasks(40);

      return {
        configPath: target.configPath,
        status: 0,
      };
    };

    const results = await runBuildTargets([target], [], runner, {
      config: createPoolConfig(),
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.durationMs).toBeGreaterThanOrEqual(35);
  });
});

describe('runBuildTargets provider blocking', () => {
  function createBuildTarget(name: string): TypecheckTarget {
    return {
      ...createSleepTarget(0, name),
      checkerName: name,
      sourceConfigPath: `/virtual/${name}/source.json`,
    };
  }

  function edge(from: string, to: string) {
    return {
      file: `/virtual/${from}/src.ts`,
      fromChecker: from,
      fromConfigPath: `/virtual/${from}/source.json`,
      importedSpecifier: to,
      resolvedFilePath: `/virtual/${to}/dist.d.ts`,
      toChecker: to,
      toConfigPath: `/virtual/${to}/source.json`,
    };
  }

  it('blocks direct and transitive consumers by root provider id', async () => {
    const provider = createBuildTarget('provider');
    const consumer = createBuildTarget('consumer');
    const transitive = createBuildTarget('transitive');
    const unrelated = createBuildTarget('unrelated');
    const calls: string[] = [];
    const results = await runBuildTargets(
      [transitive, consumer, provider, unrelated],
      [edge('consumer', 'provider'), edge('transitive', 'consumer')],
      async (target) => {
        calls.push(target.id);
        return {
          configPath: target.configPath,
          status: target.id === provider.id ? 1 : 0,
        };
      },
      { config: createPoolConfig() },
    );

    expect(calls).toContain(provider.id);
    expect(calls).toContain(unrelated.id);
    expect(calls).not.toContain(consumer.id);
    expect(calls).not.toContain(transitive.id);
    expect(
      results.find((result) => result.id === consumer.id)?.blockedBy,
    ).toEqual([provider.id]);
    expect(
      results.find((result) => result.id === transitive.id)?.blockedBy,
    ).toEqual([provider.id]);
  });

  it('does not add provider completion gating in watch mode', async () => {
    const provider = createBuildTarget('provider');
    const consumer = createBuildTarget('consumer');
    const calls: string[] = [];
    await runBuildTargets(
      [consumer, provider],
      [edge('consumer', 'provider')],
      async (target) => {
        calls.push(target.id);
        return { configPath: target.configPath, status: 0 };
      },
      { config: createPoolConfig(), watch: true },
    );

    expect(calls.sort()).toEqual([consumer.id, provider.id].sort());
  });

  it('does not cancel targets that execute inside the same provider SCC', async () => {
    const first = createBuildTarget('first');
    const second = createBuildTarget('second');
    const calls: string[] = [];
    const results = await runBuildTargets(
      [first, second],
      [edge('first', 'second'), edge('second', 'first')],
      async (target) => {
        calls.push(target.id);
        return {
          configPath: target.configPath,
          status: target.id === first.id ? 1 : 0,
        };
      },
      { config: createPoolConfig() },
    );

    expect(calls.sort()).toEqual([first.id, second.id].sort());
    const secondResult = results.find((result) => result.id === second.id);
    expect(secondResult).toMatchObject({ status: 0 });
    expect(secondResult).not.toHaveProperty('blockedBy');
  });

  it('settles every runnable SCC member with concurrency one after a sibling fails', async () => {
    const first = createBuildTarget('first');
    const second = createBuildTarget('second');
    const calls: string[] = [];
    const config = createPoolConfig();
    config.execution = { checkerBuild: 1 };

    await runBuildTargets(
      [first, second],
      [edge('first', 'second'), edge('second', 'first')],
      async (target) => {
        calls.push(target.id);
        return {
          configPath: target.configPath,
          status: target.id === first.id ? 1 : 0,
        };
      },
      { config },
    );

    expect(calls).toEqual([first.id, second.id]);
  });

  it('propagates every real SCC failure root in stable target plan order', async () => {
    const first = createBuildTarget('first');
    const second = createBuildTarget('second');
    const consumer = createBuildTarget('consumer');
    const results = await runBuildTargets(
      [first, second, consumer],
      [
        edge('first', 'second'),
        edge('second', 'first'),
        edge('consumer', 'first'),
      ],
      async (target) => ({
        configPath: target.configPath,
        status: target.id === consumer.id ? 0 : 1,
      }),
      { config: createPoolConfig() },
    );

    expect(results.find((result) => result.id === consumer.id)).toMatchObject({
      blockedBy: [first.id, second.id],
      status: 1,
    });
  });

  it('blocks downstream on failed SCC members while retaining passed siblings', async () => {
    const first = createBuildTarget('first');
    const second = createBuildTarget('second');
    const consumer = createBuildTarget('consumer');
    const results = await runBuildTargets(
      [first, second, consumer],
      [
        edge('first', 'second'),
        edge('second', 'first'),
        edge('consumer', 'first'),
      ],
      async (target) => ({
        configPath: target.configPath,
        status: target.id === first.id ? 1 : 0,
      }),
      { config: createPoolConfig() },
    );

    expect(results.find((result) => result.id === second.id)).toMatchObject({
      status: 0,
    });
    expect(results.find((result) => result.id === consumer.id)).toMatchObject({
      blockedBy: [first.id],
    });
  });

  it('merges all failed upstream components and keeps unrelated work runnable', async () => {
    const first = createBuildTarget('first');
    const second = createBuildTarget('second');
    const consumer = createBuildTarget('consumer');
    const unrelated = createBuildTarget('unrelated');
    const calls: string[] = [];
    const results = await runBuildTargets(
      [first, second, consumer, unrelated],
      [edge('consumer', 'first'), edge('consumer', 'second')],
      async (target) => {
        calls.push(target.id);
        return {
          configPath: target.configPath,
          status: target.id === first.id || target.id === second.id ? 1 : 0,
        };
      },
      { config: createPoolConfig() },
    );

    expect(calls).toContain(unrelated.id);
    expect(calls).not.toContain(consumer.id);
    expect(results.find((result) => result.id === consumer.id)).toMatchObject({
      blockedBy: [first.id, second.id],
    });
  });
});
