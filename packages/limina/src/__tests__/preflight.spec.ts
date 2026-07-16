import type {
  ResolvedCheckerConfig,
  ResolvedLiminaConfig,
} from '#config/runner';
import { type AnalysisProviderSet, createAnalysisProviders } from '#core';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createLiminaArtifactNamespace,
  type LiminaArtifactNamespace,
} from '../domain/artifacts/namespace';
import {
  type ArtifactChange,
  createArtifactPlan,
} from '../domain/artifacts/plan';
import { LiminaPreflightManager } from '../preflight';
import { createProfilingMetricsRecorder } from '../profiling/metrics';
import { toPortablePath } from './helpers/path';
import { createPreflightGenerationController } from './helpers/preflight-generation';

function createConfig(rootDir: string): ResolvedLiminaConfig {
  return {
    configPath: path.join(rootDir, 'limina.config.mjs'),
    package: {
      entries: [
        {
          checks: ['boundary'],
          name: '@fixture/pkg',
          outDir: 'packages/pkg/dist',
        },
      ],
    },
    rootDir,
  };
}

function createGraph(
  namespace: LiminaArtifactNamespace,
  changes: readonly ArtifactChange[] = [],
  ownedPaths: readonly string[] = [],
): GeneratedTsconfigGraphResult {
  const artifactPlan = createArtifactPlan(namespace, changes, ownedPaths);
  return {
    artifactPlan,
    changed: artifactPlan.changes.length > 0,
  } as GeneratedTsconfigGraphResult;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function createFakeCore(options: {
  config: ResolvedLiminaConfig;
  getGraph?: () => Promise<GeneratedTsconfigGraphResult>;
  namespace: LiminaArtifactNamespace;
}): AnalysisProviderSet {
  const providers = createAnalysisProviders(options.config, options.namespace);
  return {
    ...providers,
    buildGraph: {
      getGraph:
        options.getGraph ?? vi.fn(async () => createGraph(options.namespace)),
    },
  } as unknown as AnalysisProviderSet;
}

async function createFixture(): Promise<{
  cleanup: () => Promise<void>;
  config: ResolvedLiminaConfig;
  rootDir: string;
}> {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-preflight-'));

  await writeFile(
    path.join(rootDir, 'limina.config.mjs'),
    'export default {};\n',
  );
  await writeFile(
    path.join(rootDir, 'package.json'),
    '{"name":"root","private":true}\n',
  );
  await writeFile(
    path.join(rootDir, 'pnpm-workspace.yaml'),
    'packages:\n  - packages/*\n',
  );
  await mkdir(path.join(rootDir, 'packages/pkg'), { recursive: true });
  await writeFile(
    path.join(rootDir, 'packages/pkg/package.json'),
    '{"name":"@fixture/pkg","private":true}\n',
  );

  return {
    cleanup: async () => {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    },
    config: createConfig(rootDir),
    rootDir,
  };
}

describe('LiminaPreflightManager', () => {
  it('caches generated graph promises within a generation', async () => {
    const fixture = await createFixture();
    const namespace = createLiminaArtifactNamespace({
      generation: 0,
      rootDir: fixture.rootDir,
    });
    let graph = createGraph(namespace);
    const getGraph = vi.fn(async () => graph);
    const manager = new LiminaPreflightManager({
      config: fixture.config,
      generatedGraphProvider: getGraph,
      providers: createFakeCore({
        config: fixture.config,
        namespace,
      }),
    });

    try {
      const [first, second] = await Promise.all([
        manager.ensureGeneratedGraph(),
        manager.ensureGeneratedGraph(),
      ]);

      expect(first).toBe(graph);
      expect(second).toBe(graph);
      expect(getGraph).toHaveBeenCalledTimes(1);

      createPreflightGenerationController(manager).startNextGeneration();
      graph = createGraph(manager.artifactNamespace);
      await expect(manager.ensureGeneratedGraph()).resolves.toBe(graph);

      expect(getGraph).toHaveBeenCalledTimes(2);
      expect(manager.run.generation).toBe('1');
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses a generatedGraphProvider before core graph access', async () => {
    const fixture = await createFixture();
    const namespace = createLiminaArtifactNamespace({
      generation: 0,
      rootDir: fixture.rootDir,
    });
    const graph = createGraph(namespace);
    const provider = vi.fn(async () => graph);
    const getGraph = vi.fn(async () => {
      throw new Error('core graph should not be used');
    });
    const manager = new LiminaPreflightManager({
      config: fixture.config,
      providers: createFakeCore({
        config: fixture.config,
        getGraph,
        namespace,
      }),
      generatedGraphProvider: provider,
    });

    try {
      await expect(manager.ensureGeneratedGraph()).resolves.toBe(graph);
      await expect(manager.ensureGeneratedGraph()).resolves.toBe(graph);

      expect(provider).toHaveBeenCalledTimes(1);
      expect(getGraph).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it('deduplicates in-flight materialization and caches one successful receipt', async () => {
    const fixture = await createFixture();
    const namespace = createLiminaArtifactNamespace({
      generation: 0,
      rootDir: fixture.rootDir,
    });
    const generatedPath = path.join(fixture.rootDir, '.limina/generated.json');
    const graph = createGraph(
      namespace,
      [
        {
          artifact: {
            content: '{}\n',
            kind: 'generated-config',
            origin: { domain: 'test' },
            path: generatedPath,
          },
          status: 'create',
        },
      ],
      [generatedPath],
    );
    const manager = new LiminaPreflightManager({
      config: fixture.config,
      generatedGraphProvider: vi.fn(async () => graph),
      providers: createFakeCore({
        config: fixture.config,
        namespace,
      }),
    });

    try {
      const receipts = await Promise.all([
        manager.ensureGeneratedArtifactsMaterialized(),
        manager.ensureGeneratedArtifactsMaterialized(),
        manager.ensureGeneratedArtifactsMaterialized(),
      ]);
      expect(receipts[0]).toBe(receipts[1]);
      expect(receipts[1]).toBe(receipts[2]);
      expect(receipts[0]?.generation).toBe(0);
      expect(await readFile(generatedPath, 'utf8')).toBe('{}\n');
    } finally {
      await fixture.cleanup();
    }
  });

  it('clears a failed materialization slot so a later call can retry', async () => {
    const fixture = await createFixture();
    const namespace = createLiminaArtifactNamespace({
      generation: 0,
      rootDir: fixture.rootDir,
    });
    const collisionPath = path.join(fixture.rootDir, '.limina/collision.json');
    await mkdir(collisionPath, { recursive: true });
    const graph = createGraph(namespace, [
      {
        artifact: {
          content: 'first',
          kind: 'generated-config',
          origin: { domain: 'test' },
          path: collisionPath,
        },
        status: 'create',
      },
    ]);
    const manager = new LiminaPreflightManager({
      config: fixture.config,
      generatedGraphProvider: async () => graph,
      providers: createFakeCore({
        config: fixture.config,
        namespace,
      }),
    });

    try {
      await expect(
        manager.ensureGeneratedArtifactsMaterialized(),
      ).rejects.toBeDefined();
      const generatedPath = path.join(
        fixture.rootDir,
        '.limina/generated.json',
      );
      (
        graph as { artifactPlan: GeneratedTsconfigGraphResult['artifactPlan'] }
      ).artifactPlan = createArtifactPlan(
        namespace,
        [
          {
            artifact: {
              content: 'second',
              kind: 'generated-config',
              origin: { domain: 'test' },
              path: generatedPath,
            },
            status: 'create',
          },
        ],
        [generatedPath],
      );
      await expect(
        manager.ensureGeneratedArtifactsMaterialized(),
      ).resolves.toMatchObject({ generation: 0 });
      expect(await readFile(generatedPath, 'utf8')).toBe('second');
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not let old generation rejection or resolution replace the new slot', async () => {
    const fixture = await createFixture();
    const namespace = createLiminaArtifactNamespace({
      generation: 0,
      rootDir: fixture.rootDir,
    });
    const oldGraph = deferred<GeneratedTsconfigGraphResult>();
    const newGraph = deferred<GeneratedTsconfigGraphResult>();
    const provider = vi
      .fn<() => Promise<GeneratedTsconfigGraphResult>>()
      .mockReturnValueOnce(oldGraph.promise)
      .mockReturnValueOnce(newGraph.promise);
    const manager = new LiminaPreflightManager({
      config: fixture.config,
      generatedGraphProvider: provider,
      providers: createFakeCore({
        config: fixture.config,
        namespace,
      }),
    });

    try {
      const oldReceipt = manager.ensureGeneratedArtifactsMaterialized();
      await vi.waitFor(() => {
        expect(provider).toHaveBeenCalledTimes(1);
      });
      createPreflightGenerationController(manager).startNextGeneration();
      const generationOneNamespace = manager.artifactNamespace;
      const newReceipt = manager.ensureGeneratedArtifactsMaterialized();
      await vi.waitFor(() => {
        expect(provider).toHaveBeenCalledTimes(2);
      });
      newGraph.resolve(createGraph(generationOneNamespace));
      await expect(newReceipt).resolves.toMatchObject({ generation: 1 });
      oldGraph.reject(new Error('old generation failed'));
      await expect(oldReceipt).rejects.toThrow('old generation failed');
      await expect(
        manager.ensureGeneratedArtifactsMaterialized(),
      ).resolves.toMatchObject({ generation: 1 });

      createPreflightGenerationController(manager).startNextGeneration();
      const generationTwoNamespace = manager.artifactNamespace;
      const lateOld = deferred<GeneratedTsconfigGraphResult>();
      const latest = deferred<GeneratedTsconfigGraphResult>();
      provider
        .mockReturnValueOnce(lateOld.promise)
        .mockReturnValueOnce(latest.promise);
      const generationTwo = manager.ensureGeneratedArtifactsMaterialized();
      await vi.waitFor(() => {
        expect(provider).toHaveBeenCalledTimes(3);
      });
      createPreflightGenerationController(manager).startNextGeneration();
      const generationThreeNamespace = manager.artifactNamespace;
      const generationThree = manager.ensureGeneratedArtifactsMaterialized();
      await vi.waitFor(() => {
        expect(provider).toHaveBeenCalledTimes(4);
      });
      latest.resolve(createGraph(generationThreeNamespace));
      await expect(generationThree).resolves.toMatchObject({ generation: 3 });
      lateOld.resolve(createGraph(generationTwoNamespace));
      await expect(generationTwo).resolves.toMatchObject({ generation: 2 });
      await expect(
        manager.ensureGeneratedArtifactsMaterialized(),
      ).resolves.toMatchObject({ generation: 3 });
    } finally {
      await fixture.cleanup();
    }
  });

  it('creates package entry plans without reading the generated graph', async () => {
    const fixture = await createFixture();
    const namespace = createLiminaArtifactNamespace({
      generation: 0,
      rootDir: fixture.rootDir,
    });
    const getGraph = vi.fn(async () => {
      throw new Error('package selection should not read the generated graph');
    });
    const manager = new LiminaPreflightManager({
      config: fixture.config,
      providers: createFakeCore({
        config: fixture.config,
        getGraph,
        namespace,
      }),
    });

    try {
      const options = {
        cwd: fixture.rootDir,
        packageNames: ['@fixture/pkg'],
        requireCwdPackageMatch: false,
        tool: 'boundary' as const,
      };
      const first = await manager.ensurePackageEntrySelectionPlan(options);
      const second = await manager.ensurePackageEntrySelectionPlan(options);

      expect(first).not.toBe(second);
      expect(first.entries).toHaveLength(1);
      expect(first.entries[0]?.label).toBe('@fixture/pkg');
      expect(getGraph).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it('shares one route traversal per normalized checker entry root while preserving projections', async () => {
    const fixture = await createFixture();
    const namespace = createLiminaArtifactNamespace({
      generation: 0,
      rootDir: fixture.rootDir,
    });
    const rootConfigPath = path.join(
      fixture.rootDir,
      '.limina/tsconfig.shared.build.json',
    );
    const rootConfigAlias = `${path.dirname(rootConfigPath)}${path.sep}.${path.sep}${path.basename(rootConfigPath)}`;
    const projectConfigPath = path.join(
      fixture.rootDir,
      '.limina/tsconfig.shared.dts.json',
    );
    await mkdir(path.dirname(rootConfigPath), { recursive: true });
    await writeFile(
      rootConfigPath,
      JSON.stringify({
        files: [],
        references: [{ path: './tsconfig.shared.dts.json' }],
      }),
    );
    await writeFile(projectConfigPath, JSON.stringify({ files: [] }));
    const checkers: ResolvedCheckerConfig[] = [
      {
        exclude: [],
        extensions: ['.ts'],
        include: [],
        name: 'typescript',
        preset: 'tsgo',
      },
      {
        exclude: [],
        extensions: ['.ts', '.vue'],
        include: [],
        name: 'vue',
        preset: 'vue-tsc',
      },
      {
        exclude: [],
        extensions: ['.svelte'],
        include: [],
        name: 'svelte',
        preset: 'svelte-check',
      },
    ];
    const graph = {
      ...createGraph(namespace),
      checkerEntries: new Map([
        ['typescript', rootConfigPath],
        ['vue', rootConfigAlias],
        ['svelte', rootConfigPath],
      ]),
      checkers,
      generatedFiles: new Map<string, string>(),
    } as GeneratedTsconfigGraphResult;
    const metrics = createProfilingMetricsRecorder();
    const manager = new LiminaPreflightManager({
      config: fixture.config,
      generatedGraphProvider: vi.fn(async () => graph),
      metrics,
      providers: createFakeCore({
        config: fixture.config,
        namespace,
      }),
    });

    try {
      const [graphRoutes, entryRoutes, sourceExtensions] = await Promise.all([
        manager.ensureGraphProjectRoutes(),
        manager.ensureCheckerEntryProjectRoutes(),
        manager.ensureSourceGraphProjectExtensions(),
      ]);

      expect(graphRoutes.problems).toEqual([]);
      expect(graphRoutes.routes.map((route) => route.checkerName)).toEqual([
        'typescript',
        'vue',
      ]);
      expect(entryRoutes.problems).toEqual([]);
      expect(entryRoutes.routes.map((route) => route.checkerName)).toEqual([
        'typescript',
        'vue',
        'svelte',
      ]);
      const portableProjectConfigPath = toPortablePath(projectConfigPath);
      expect(
        sourceExtensions.projectContextsByPath.get(portableProjectConfigPath)
          ?.checkerPresets,
      ).toEqual(['tsgo', 'vue-tsc']);
      expect(
        sourceExtensions.projectExtensionsByPath.get(portableProjectConfigPath),
      ).toEqual(expect.arrayContaining(['.ts', '.vue']));
      expect(
        sourceExtensions.projectExtensionsByPath.get(portableProjectConfigPath),
      ).not.toContain('.svelte');

      const snapshot = metrics.snapshot();
      const countMetric = (name: string, kind: string): number | undefined =>
        snapshot.find((metric) => metric.name === name && metric.kind === kind)
          ?.count;
      expect(countMetric('checker-route-projection', 'checker-snapshot')).toBe(
        3,
      );
      expect(countMetric('checker-route-projection', 'unique-entry-root')).toBe(
        1,
      );
      expect(countMetric('checker-route-traversal', 'traversal')).toBe(1);
      expect(countMetric('checker-route-traversal', 'cache-hit')).toBe(2);
      expect(countMetric('checker-route-projection', 'graph-route')).toBe(1);
      expect(countMetric('checker-route-projection', 'entry-route')).toBe(1);
      expect(countMetric('checker-route-projection', 'source-extension')).toBe(
        1,
      );
      expect(
        countMetric('checker-route-traversal', 'traversal') ?? 0,
      ).toBeLessThanOrEqual(
        countMetric('checker-route-projection', 'unique-entry-root') ?? 0,
      );

      createPreflightGenerationController(manager).startNextGeneration();
      await manager.ensureGraphProjectRoutes();
      expect(
        metrics
          .snapshot()
          .find(
            (metric) =>
              metric.name === 'checker-route-traversal' &&
              metric.kind === 'traversal',
          )?.count,
      ).toBe(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it('preserves projection-specific missing-entry diagnostics', async () => {
    const fixture = await createFixture();
    const namespace = createLiminaArtifactNamespace({
      generation: 0,
      rootDir: fixture.rootDir,
    });
    const checkers: ResolvedCheckerConfig[] = [
      {
        exclude: [],
        extensions: ['.ts'],
        include: [],
        name: 'typescript',
        preset: 'tsgo',
      },
      {
        exclude: [],
        extensions: ['.ts', '.vue'],
        include: [],
        name: 'vue',
        preset: 'vue-tsc',
      },
      {
        exclude: [],
        extensions: ['.svelte'],
        include: [],
        name: 'svelte',
        preset: 'svelte-check',
      },
    ];
    const graph = {
      ...createGraph(namespace),
      checkerEntries: new Map([
        ['vue', path.join(fixture.rootDir, '.limina/missing-vue.build.json')],
        [
          'svelte',
          path.join(fixture.rootDir, '.limina/missing-svelte.build.json'),
        ],
      ]),
      checkers,
      generatedFiles: new Map<string, string>(),
    } as GeneratedTsconfigGraphResult;
    const manager = new LiminaPreflightManager({
      config: fixture.config,
      generatedGraphProvider: vi.fn(async () => graph),
      providers: createFakeCore({
        config: fixture.config,
        namespace,
      }),
    });

    try {
      const graphRoutes = await manager.ensureGraphProjectRoutes();
      const entryRoutes = await manager.ensureCheckerEntryProjectRoutes();
      const sourceExtensions =
        await manager.ensureSourceGraphProjectExtensions();
      expect(graphRoutes.problems).toEqual([
        [
          'Missing generated checker graph entry:',
          '  checker: typescript',
          '  reason: run limina graph prepare before collecting checker graph routes.',
        ].join('\n'),
        [
          'Checker graph entry references a missing tsconfig:',
          '  checker: vue',
          '  config: .limina/missing-vue.build.json',
        ].join('\n'),
      ]);
      expect(entryRoutes.problems).toEqual([
        [
          'Missing generated checker entry:',
          '  checker: typescript',
          '  reason: run limina graph prepare before collecting checker entry routes.',
        ].join('\n'),
        [
          'Checker entry references a missing tsconfig:',
          '  checker: vue',
          '  config: .limina/missing-vue.build.json',
        ].join('\n'),
        [
          'Checker entry references a missing tsconfig:',
          '  checker: svelte',
          '  config: .limina/missing-svelte.build.json',
        ].join('\n'),
      ]);
      expect(sourceExtensions.problems).toEqual(graphRoutes.problems);
    } finally {
      await fixture.cleanup();
    }
  });
});
