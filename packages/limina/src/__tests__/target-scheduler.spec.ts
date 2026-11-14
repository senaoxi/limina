import type { ResolvedLiminaConfig } from '#config/runner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GeneratedDependencyEdge } from '../core/build-graph/runner';
import { runBuildTargets } from '../typecheck/build/target-execution';
import {
  createCheckerTargetId,
  type TypecheckTarget,
} from '../typecheck/targets';
import { withFixtureGovernanceRoot } from './helpers/governance-root';

function target(name: string): TypecheckTarget {
  return {
    args: [],
    command: process.execPath,
    configPath: `/virtual/${name}.json`,
    cwd: '/virtual',
    checkerName: name,
    id: createCheckerTargetId([name]),
  };
}
function edge(
  consumer: TypecheckTarget,
  provider: TypecheckTarget,
): GeneratedDependencyEdge {
  return {
    kind: 'framework-schedule',
    file: consumer.configPath,
    importedSpecifier: provider.configPath,
    resolvedFilePath: provider.configPath,
    fromChecker: consumer.checkerName!,
    toChecker: provider.checkerName!,
    fromConfigPath: consumer.configPath,
    toConfigPath: provider.configPath,
  };
}
function config(concurrency = 2): ResolvedLiminaConfig {
  return withFixtureGovernanceRoot({
    configPath: '/virtual/limina.config.mjs',
    rootDir: '/virtual',
    concurrency: { checkerBuild: concurrency },
  });
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('checker target ready frontier', () => {
  it.each([0, 1])(
    'releases a consumer after its provider settles with exit %s while unrelated work continues',
    async (status) => {
      vi.useFakeTimers();
      const [provider, slow, consumer] = [
        target('provider'),
        target('slow'),
        target('consumer'),
      ] as const;
      const events: string[] = [];
      const run = runBuildTargets(
        [provider, slow, consumer],
        [edge(consumer, provider)],
        async (item) => {
          events.push(`start:${item.checkerName}`);
          await sleep(item === slow ? 100 : 10);
          events.push(`end:${item.checkerName}`);
          return {
            configPath: item.configPath,
            status: item === provider ? status : 0,
          };
        },
        { config: config() },
      );
      await vi.runAllTimersAsync();
      const results = await run;
      expect(events.indexOf('start:consumer')).toBeLessThan(
        events.indexOf('end:slow'),
      );
      expect(events.indexOf('end:provider')).toBeLessThan(
        events.indexOf('start:consumer'),
      );
      expect(results.map((result) => result.id)).toEqual([
        provider.id,
        slow.id,
        consumer.id,
      ]);
      expect(results.map((result) => result.status)).toEqual([status, 0, 0]);
    },
  );

  it.each([1, 2])(
    'keeps the target limit %s across ready components and waits for every SCC member',
    async (concurrency) => {
      vi.useFakeTimers();
      const [a, b, c, d] = [
        target('a'),
        target('b'),
        target('c'),
        target('d'),
      ] as const;
      const events: string[] = [];
      let active = 0;
      let maximum = 0;
      const run = runBuildTargets(
        [a, b, c, d],
        [edge(a, b), edge(b, a), edge(c, a)],
        async (item) => {
          active += 1;
          maximum = Math.max(maximum, active);
          events.push(`start:${item.checkerName}`);
          await sleep(item === b ? 100 : 10);
          events.push(`end:${item.checkerName}`);
          active -= 1;
          return { configPath: item.configPath, status: 0 };
        },
        { config: config(concurrency) },
      );
      await vi.runAllTimersAsync();
      expect((await run).map((result) => result.id)).toEqual([
        a.id,
        b.id,
        c.id,
        d.id,
      ]);
      expect(maximum).toBe(concurrency);
      expect(events.indexOf('start:c')).toBeGreaterThan(
        events.indexOf('end:a'),
      );
      expect(events.indexOf('start:c')).toBeGreaterThan(
        events.indexOf('end:b'),
      );
    },
  );

  it.each(['process', 'copy'] as const)(
    'retains transitive prerequisite roots after %s failure',
    async (failure) => {
      const [a, b, c, healthy] = [
        target('a'),
        target('b'),
        target('c'),
        target('healthy'),
      ] as const;
      const started: string[] = [];
      const results = await runBuildTargets(
        [a, b, c, healthy],
        [],
        (item) => {
          started.push(item.checkerName!);
          return {
            configPath: item.configPath,
            status: failure === 'process' && item === a ? 1 : 0,
          };
        },
        {
          config: config(),
          executionPrerequisites: [edge(b, a), edge(c, b)],
          isDeliveryComplete: (id) => id === healthy.id,
        },
      );
      expect(started).toEqual(['a', 'healthy']);
      expect(results[0]?.status).toBe(failure === 'process' ? 1 : 0);
      expect(results[1]).toEqual({
        id: b.id,
        status: 'blocked',
        blockedBy: [a.id],
      });
      expect(results[2]).toEqual({
        id: c.id,
        status: 'blocked',
        blockedBy: [a.id],
      });
      expect(results[3]?.status).toBe(0);
    },
  );

  it('waits for output delivery before starting a dependent target', async () => {
    vi.useFakeTimers();
    const [a, b] = [target('a'), target('b')] as const;
    const events: string[] = [];
    const run = runBuildTargets(
      [a, b],
      [],
      () => {
        throw new Error('unexpected runner');
      },
      {
        config: config(),
        executionPrerequisites: [edge(b, a)],
        executeTarget: async (item) => {
          events.push(`start:${item.checkerName}`);
          if (item === a) {
            events.push('checker-exit');
            await sleep(100);
            events.push('copy-complete');
          }
          return {
            id: item.id,
            configPath: item.configPath,
            durationMs: 1,
            status: 0,
          };
        },
      },
    );
    await vi.runAllTimersAsync();
    expect((await run).every((result) => result.status === 0)).toBe(true);
    expect(events).toEqual([
      'start:a',
      'checker-exit',
      'copy-complete',
      'start:b',
    ]);
  });

  it('drains running targets after a result observer fails without releasing consumers', async () => {
    vi.useFakeTimers();
    const [a, b, c] = [target('a'), target('b'), target('c')] as const;
    const events: string[] = [];
    const failure = new Error('observer');
    const run = runBuildTargets(
      [a, b, c],
      [edge(c, a)],
      async (item) => {
        events.push(`start:${item.checkerName}`);
        await sleep(item === b ? 100 : 10);
        events.push(`end:${item.checkerName}`);
        return { configPath: item.configPath, status: 0 };
      },
      {
        config: config(),
        onTargetResult: (item) => {
          if (item === a) throw failure;
        },
      },
    );
    const result = (async () => {
      try {
        return await run;
      } catch (error) {
        events.push('rejected');
        return error;
      }
    })();
    await vi.runAllTimersAsync();
    expect(await result).toBe(failure);
    expect(events).not.toContain('start:c');
    expect(events.indexOf('end:b')).toBeLessThan(events.indexOf('rejected'));
  });

  it('starts all watch targets without waiting for dependencies or the finite-work cap', async () => {
    vi.useFakeTimers();
    const [a, b, c] = [target('a'), target('b'), target('c')] as const;
    const events: string[] = [];
    const run = runBuildTargets(
      [a, b, c],
      [edge(b, a), edge(c, b)],
      async (item) => {
        events.push(`start:${item.checkerName}`);
        await sleep(100);
        events.push(`end:${item.checkerName}`);
        return { configPath: item.configPath, status: 0 };
      },
      { config: config(1), watch: true },
    );
    await vi.runAllTimersAsync();
    expect(await run).toHaveLength(3);
    expect(events.slice(0, 3)).toEqual(['start:a', 'start:b', 'start:c']);
  });
});
