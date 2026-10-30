import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { LiminaPreflightManager } from '../preflight/manager';
import { executeCheckerBuildTargets } from '../typecheck/checker/build-execution';
import { createCheckerTarget } from '../typecheck/targets';
import { withFixtureGovernanceRoot } from './helpers/governance-root';
import { createSemanticRepairFixture } from './helpers/semantic-repair';

async function createHandoffFixture(hasMissingInput = false) {
  const compilerOptions = {
    module: 'NodeNext',
    noLib: true,
    types: [],
    strict: true,
  };
  const f = await createSemanticRepairFixture({
    'package.json': JSON.stringify({
      name: 'handoff',
      private: true,
      type: 'module',
    }),
    'pnpm-workspace.yaml': 'packages:\n  - .\n',
    'limina.config.mjs': 'export default {};',
    'tsconfig.json': JSON.stringify({
      files: [],
      references: [
        { path: './a' },
        { path: './b' },
        { path: './d' },
        { path: './x' },
      ],
    }),
    'a/index.ts': hasMissingInput
      ? '/// <reference path="../b/dist/global.d.ts" />\nexport const value: Provided = 1;'
      : 'import { value } from "../b/dist/index.js"; export const a = value;',
    'a/tsconfig.json': JSON.stringify({ compilerOptions, files: ['index.ts'] }),
    'b/src/index.ts': 'export const value = "new";',
    'b/dist/index.d.ts': 'export declare const value: number;',
    ...(hasMissingInput && { 'b/src/global.d.ts': 'type Provided = number;' }),
    'b/tsconfig.json': JSON.stringify({
      compilerOptions,
      files: hasMissingInput
        ? ['src/index.ts', 'src/global.d.ts']
        : ['src/index.ts'],
      liminaOptions: {
        outputs: { rootDir: 'src', outDir: 'dist' },
        ...(hasMissingInput && {
          graphRules: ['denied'],
          implicitRefs: [{ path: '../x/tsconfig.json', reason: 'fixture' }],
        }),
      },
    }),
    'x/src/index.ts': 'export const irrelevant = 1;',
    'x/dist/index.d.ts': 'export declare const irrelevant: number;',
    'x/tsconfig.json': JSON.stringify({
      compilerOptions,
      files: ['src/index.ts'],
      liminaOptions: { outputs: { rootDir: 'src', outDir: 'dist' } },
    }),
    'd/index.ts': 'export const independent = 1;',
    'd/tsconfig.json': JSON.stringify({ compilerOptions, files: ['index.ts'] }),
  });
  const config = withFixtureGovernanceRoot({
    rootDir: f.root,
    configPath: f.path('limina.config.mjs'),
    cache: false,
    concurrency: { checkerBuild: 3 },
    scope: { checkers: { tsc: { include: ['tsconfig.json'] } } },
    ...(hasMissingInput && {
      graph: {
        rules: {
          denied: {
            deny: {
              refs: [{ path: 'x/tsconfig.json', reason: 'refuse provider' }],
            },
          },
        },
      },
    }),
  });
  const preflight = new LiminaPreflightManager({ config });
  const graph = (await preflight.ensureGeneratedArtifactsMaterialized()).graph;
  const checker = graph.checkers.find((item) => item.name === 'tsc')!;
  const targets = ['b', 'a', 'd', 'x'].map((name) =>
    createCheckerTarget({
      checker,
      configPath: (['b', 'x'].includes(name)
        ? graph.configToOutputBuild
        : graph.sourceToBuild
      )
        .get('tsc')!
        .get(f.path(`${name}/tsconfig.json`))!.path,
      executionKind: 'build',
      projectRootDir: f.root,
      sourceConfigPath: f.path(`${name}/tsconfig.json`),
    }),
  );
  return { f, config, preflight, graph, targets };
}

it('blocks a missing-input consumer when its selected producer is denied', async () => {
  const input = await createHandoffFixture(true);
  const started: string[] = [];
  try {
    const result = await executeCheckerBuildTargets({
      allCheckers: input.graph.checkers,
      config: input.config,
      flowDepth: 0,
      generatedGraph: input.graph,
      label: 'necessary delivery',
      preflight: input.preflight,
      projectRootDir: input.f.root,
      targets: input.targets.slice(0, 3),
      watch: undefined,
      workspaceContext: await input.preflight.ensureWorkspaceValidated(),
      runnerOptions: {
        config: input.config,
        report: { defer: true },
        runner: (target) => {
          started.push(target.sourceConfigPath!);
          return { configPath: target.configPath, status: 0 };
        },
      },
    });
    expect(started).toEqual([input.f.path('d/tsconfig.json')]);
    expect(result.targetOutcomes).toContainEqual(
      expect.objectContaining({ id: input.targets[1]!.id, status: 'blocked' }),
    );
    expect(result.targetOutcomes).toContainEqual(
      expect.objectContaining({
        id: input.targets[0]!.id,
        status: 'admission-rejected',
        decision: 'denied',
      }),
    );
    expect(result.failureKind).toBe('execution-admission');
  } finally {
    input.preflight.dispose();
    await input.f.cleanup();
  }
});

describe('execution input handoff', () => {
  it.each([false, true])(
    'refreshes produced declaration evidence without accepting source drift (drift=%s)',
    async (hasSourceDrift) => {
      const input = await createHandoffFixture();
      const events: string[] = [];
      const providerDone = Promise.withResolvers<void>();
      const providerStarted = Promise.withResolvers<void>();
      const allowWrite = Promise.withResolvers<void>();
      const independentStarted = Promise.withResolvers<void>();
      const originalSnapshot = input.preflight.run.snapshotToken;
      try {
        const options: Parameters<typeof executeCheckerBuildTargets>[0] = {
          allCheckers: input.graph.checkers,
          config: input.config,
          flowDepth: 0,
          generatedGraph: input.graph,
          label: 'handoff',
          preflight: input.preflight,
          projectRootDir: input.f.root,
          targets: [input.targets[0]!, input.targets[2]!],
          watch: undefined,
          workspaceContext: await input.preflight.ensureWorkspaceValidated(),
          runnerOptions: {
            config: input.config,
            report: { defer: true },
            runner: async (target) => {
              if (target.id === input.targets[0]!.id) {
                events.push('provider-start');
                providerStarted.resolve();
                await allowWrite.promise;
                await independentStarted.promise;
                await writeFile(
                  input.f.path('b/dist/index.d.ts'),
                  'export declare const value: string;',
                );
                if (hasSourceDrift)
                  await writeFile(
                    input.f.path('a/index.ts'),
                    'export const changed = 1;',
                  );
                events.push('provider-done');
                providerDone.resolve();
              } else if (target.id === input.targets[1]!.id) {
                events.push('consumer');
              } else {
                events.push('independent');
                independentStarted.resolve();
                await providerDone.promise;
              }
              return { configPath: target.configPath, status: 0 };
            },
          },
        };
        const producers = executeCheckerBuildTargets(options);
        await Promise.race([
          providerStarted.promise,
          rejectEarlyCompletion(producers),
        ]);
        const consumer = executeCheckerBuildTargets({
          ...options,
          targets: [input.targets[1]!],
        });
        allowWrite.resolve();
        const [producerResult, result] = await Promise.all([
          producers,
          consumer,
        ]);
        expect(producerResult.failedTargets).toEqual([]);
        expect(events).toContain('independent');
        expect(events.indexOf('independent')).toBeLessThan(
          events.indexOf('provider-done'),
        );
        if (hasSourceDrift) {
          expect(events).not.toContain('consumer');
          expect(result.targetOutcomes).toContainEqual(
            expect.objectContaining({
              id: input.targets[1]!.id,
              status: 'admission-rejected',
              decision: 'unavailable',
            }),
          );
        } else {
          expect(result.failedTargets).toEqual([]);
          expect(events.indexOf('consumer')).toBeGreaterThan(
            events.indexOf('provider-done'),
          );
          expect(input.preflight.run.snapshotToken).not.toBe(originalSnapshot);
        }
      } finally {
        providerDone.resolve();
        allowWrite.resolve();
        independentStarted.resolve();
        input.preflight.dispose();
        await input.f.cleanup();
      }
    },
  );
});

async function rejectEarlyCompletion(
  pending: ReturnType<typeof executeCheckerBuildTargets>,
): Promise<never> {
  const result = await pending;
  throw new Error(JSON.stringify(result.failedTargets));
}

it.each(['unrelated-output', 'related-output'])(
  'validates only receipts consumed by a pending target (%s)',
  async (change) => {
    const input = await createHandoffFixture();
    const started: string[] = [];
    const options: Parameters<typeof executeCheckerBuildTargets>[0] = {
      allCheckers: input.graph.checkers,
      config: input.config,
      flowDepth: 0,
      generatedGraph: input.graph,
      label: 'handoff locality',
      preflight: input.preflight,
      projectRootDir: input.f.root,
      targets: [],
      watch: undefined,
      workspaceContext: await input.preflight.ensureWorkspaceValidated(),
      runnerOptions: {
        config: input.config,
        report: { defer: true },
        runner: async (target) => {
          started.push(target.sourceConfigPath!);
          if (target === input.targets[0])
            await writeFile(
              input.f.path('b/dist/index.d.ts'),
              'export declare const value: string;',
            );
          if (target === input.targets[3])
            await writeFile(
              input.f.path('x/dist/index.d.ts'),
              'export declare const irrelevant: string;',
            );
          return { configPath: target.configPath, status: 0 };
        },
      },
    };
    try {
      const producers = await executeCheckerBuildTargets({
        ...options,
        targets: [input.targets[0]!, input.targets[3]!],
      });
      expect(producers.failedTargets).toEqual([]);
      await writeFile(
        input.f.path(
          change === 'unrelated-output'
            ? 'x/dist/index.d.ts'
            : 'b/dist/index.d.ts',
        ),
        'export declare const changed: boolean;',
      );
      started.length = 0;
      const result = await executeCheckerBuildTargets({
        ...options,
        targets: [input.targets[1]!, input.targets[2]!],
      });
      expect(started).toContain(input.f.path('d/tsconfig.json'));
      expect(started.includes(input.f.path('a/tsconfig.json'))).toBe(
        change === 'unrelated-output',
      );
      expect(result.passed).toBe(change === 'unrelated-output');
    } finally {
      input.preflight.dispose();
      await input.f.cleanup();
    }
  },
);

it('waits for a single refreshed execution view before preparing another target', async () => {
  const input = await createHandoffFixture();
  const refreshed = Promise.withResolvers<void>();
  const publish = Promise.withResolvers<void>();
  const started: string[] = [];
  const refresh = input.preflight.refreshAfterManagedOutputs.bind(
    input.preflight,
  );
  input.preflight.refreshAfterManagedOutputs = async () => {
    const receipt = await refresh();
    refreshed.resolve();
    await publish.promise;
    return receipt;
  };
  const options: Parameters<typeof executeCheckerBuildTargets>[0] = {
    allCheckers: input.graph.checkers,
    config: input.config,
    flowDepth: 0,
    generatedGraph: input.graph,
    label: 'refresh barrier',
    preflight: input.preflight,
    projectRootDir: input.f.root,
    targets: [],
    watch: undefined,
    workspaceContext: await input.preflight.ensureWorkspaceValidated(),
    runnerOptions: {
      config: input.config,
      report: { defer: true },
      runner: async (target) => {
        started.push(target.sourceConfigPath!);
        if (target === input.targets[0])
          await writeFile(
            input.f.path('b/dist/index.d.ts'),
            'export declare const value: string;',
          );
        return { configPath: target.configPath, status: 0 };
      },
    },
  };
  try {
    expect(
      (
        await executeCheckerBuildTargets({
          ...options,
          targets: [input.targets[0]!],
        })
      ).passed,
    ).toBe(true);
    const consumer = executeCheckerBuildTargets({
      ...options,
      targets: [input.targets[1]!],
    });
    await Promise.race([refreshed.promise, rejectEarlyCompletion(consumer)]);
    const independent = executeCheckerBuildTargets({
      ...options,
      generatedGraph: await input.preflight.ensureGeneratedGraph(),
      targets: [input.targets[2]!],
    });
    await Promise.resolve();
    expect(started).not.toContain(input.f.path('d/tsconfig.json'));
    publish.resolve();
    const results = await Promise.all([consumer, independent]);
    expect(results.flatMap((result) => result.failedTargets)).toEqual([]);
    expect(started).toContain(input.f.path('d/tsconfig.json'));
  } finally {
    publish.resolve();
    input.preflight.dispose();
    await input.f.cleanup();
  }
});
