import type { ResolvedLiminaConfig } from '#config/runner';
import type { AnalysisProviderSet } from '#core';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LiminaPreflightManager } from '../preflight';
import { createPreflightGenerationController } from './helpers/preflight-generation';

function createConfig(rootDir: string): ResolvedLiminaConfig {
  return {
    configPath: path.join(rootDir, 'limina.config.mjs'),
    package: {
      entries: [
        {
          checks: ['boundary'],
          name: '@fixture/pkg',
          outDir: path.join(rootDir, 'packages/pkg/dist'),
        },
      ],
    },
    rootDir,
  };
}

function createGraph(
  artifactPlan: GeneratedTsconfigGraphResult['artifactPlan'] = {
    changes: [],
    ownedPaths: [],
  },
): GeneratedTsconfigGraphResult {
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
  getGraph?: () => Promise<GeneratedTsconfigGraphResult>;
}): AnalysisProviderSet {
  return {
    buildGraph: {
      getGraph: options.getGraph ?? vi.fn(async () => createGraph()),
    },
    imports: {
      context: {},
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
    const graph = createGraph();
    const getGraph = vi.fn(async () => graph);
    const manager = new LiminaPreflightManager({
      config: fixture.config,
      generatedGraphProvider: getGraph,
      providers: createFakeCore({}),
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
      await expect(manager.ensureGeneratedGraph()).resolves.toBe(graph);

      expect(getGraph).toHaveBeenCalledTimes(2);
      expect(manager.run.generation).toBe('1');
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses a generatedGraphProvider before core graph access', async () => {
    const fixture = await createFixture();
    const graph = createGraph();
    const provider = vi.fn(async () => graph);
    const getGraph = vi.fn(async () => {
      throw new Error('core graph should not be used');
    });
    const manager = new LiminaPreflightManager({
      config: fixture.config,
      providers: createFakeCore({ getGraph }),
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
    const generatedPath = path.join(fixture.rootDir, '.limina/generated.json');
    const graph = createGraph({
      changes: [
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
      ownedPaths: [generatedPath],
    });
    const manager = new LiminaPreflightManager({
      config: fixture.config,
      generatedGraphProvider: vi.fn(async () => graph),
      providers: createFakeCore({}),
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
    const graph = createGraph({
      changes: [
        {
          artifact: {
            content: 'first',
            kind: 'generated-config',
            origin: { domain: 'test' },
            path: fixture.rootDir,
          },
          status: 'create',
        },
      ],
      ownedPaths: [],
    });
    const manager = new LiminaPreflightManager({
      config: fixture.config,
      generatedGraphProvider: async () => graph,
      providers: createFakeCore({}),
    });

    try {
      await expect(
        manager.ensureGeneratedArtifactsMaterialized(),
      ).rejects.toBeDefined();
      const generatedPath = path.join(fixture.rootDir, 'generated.json');
      (
        graph as { artifactPlan: GeneratedTsconfigGraphResult['artifactPlan'] }
      ).artifactPlan = {
        changes: [
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
        ownedPaths: [generatedPath],
      };
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
    const oldGraph = deferred<GeneratedTsconfigGraphResult>();
    const newGraph = deferred<GeneratedTsconfigGraphResult>();
    const provider = vi
      .fn<() => Promise<GeneratedTsconfigGraphResult>>()
      .mockReturnValueOnce(oldGraph.promise)
      .mockReturnValueOnce(newGraph.promise);
    const manager = new LiminaPreflightManager({
      config: fixture.config,
      generatedGraphProvider: provider,
      providers: createFakeCore({}),
    });

    try {
      const oldReceipt = manager.ensureGeneratedArtifactsMaterialized();
      createPreflightGenerationController(manager).startNextGeneration();
      const newReceipt = manager.ensureGeneratedArtifactsMaterialized();
      newGraph.resolve(createGraph());
      await expect(newReceipt).resolves.toMatchObject({ generation: 1 });
      oldGraph.reject(new Error('old generation failed'));
      await expect(oldReceipt).rejects.toThrow('old generation failed');
      await expect(
        manager.ensureGeneratedArtifactsMaterialized(),
      ).resolves.toMatchObject({ generation: 1 });

      createPreflightGenerationController(manager).startNextGeneration();
      const lateOld = deferred<GeneratedTsconfigGraphResult>();
      const latest = deferred<GeneratedTsconfigGraphResult>();
      provider
        .mockReturnValueOnce(lateOld.promise)
        .mockReturnValueOnce(latest.promise);
      const generationTwo = manager.ensureGeneratedArtifactsMaterialized();
      createPreflightGenerationController(manager).startNextGeneration();
      const generationThree = manager.ensureGeneratedArtifactsMaterialized();
      latest.resolve(createGraph());
      await expect(generationThree).resolves.toMatchObject({ generation: 3 });
      lateOld.resolve(createGraph());
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
    const getGraph = vi.fn(async () => {
      throw new Error('package selection should not read the generated graph');
    });
    const manager = new LiminaPreflightManager({
      config: fixture.config,
      providers: createFakeCore({ getGraph }),
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
});
