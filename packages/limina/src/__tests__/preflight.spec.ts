import type { ResolvedLiminaConfig } from '#config/runner';
import type { LiminaCore } from '#core';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LiminaPreflightManager } from '../preflight';

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

function createGraph(): GeneratedTsconfigGraphResult {
  return {} as GeneratedTsconfigGraphResult;
}

function createFakeCore(options: {
  getGraph?: () => Promise<GeneratedTsconfigGraphResult>;
  invalidateAll?: () => void;
}): LiminaCore {
  return {
    buildGraph: {
      getGraph: options.getGraph ?? vi.fn(async () => createGraph()),
    },
    imports: {
      context: {},
    },
    invalidateAll: options.invalidateAll ?? vi.fn(),
  } as unknown as LiminaCore;
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
  it('caches generated graph promises until invalidated', async () => {
    const fixture = await createFixture();
    const graph = createGraph();
    const getGraph = vi.fn(async () => graph);
    const invalidateAll = vi.fn();
    const manager = new LiminaPreflightManager({
      config: fixture.config,
      core: createFakeCore({
        getGraph,
        invalidateAll,
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

      manager.invalidateAll();
      await expect(manager.ensureGeneratedGraph()).resolves.toBe(graph);

      expect(invalidateAll).toHaveBeenCalledTimes(1);
      expect(getGraph).toHaveBeenCalledTimes(2);
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
      core: createFakeCore({ getGraph }),
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

  it('caches package entry selection plans without reading the generated graph', async () => {
    const fixture = await createFixture();
    const getGraph = vi.fn(async () => {
      throw new Error('package selection should not read the generated graph');
    });
    const manager = new LiminaPreflightManager({
      config: fixture.config,
      core: createFakeCore({ getGraph }),
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

      expect(first).toBe(second);
      expect(first.entries).toHaveLength(1);
      expect(first.entries[0]?.label).toBe('@fixture/pkg');
      expect(getGraph).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });
});
