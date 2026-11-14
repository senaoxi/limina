import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config/loader';
import { AnalysisInputs } from '../core/analysis-cache/inputs';
import { LiminaPreflightManager } from '../preflight';
import { createPreflightGenerationController } from '../preflight/generation';
import { createProfilingMetricsRecorder } from '../profiling/metrics';
import { createFixturePathResolver } from './helpers/path';

const requireFromTest = createRequire(import.meta.url);
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const compilerOptions = {
  composite: true,
  declaration: true,
  emitDeclarationOnly: true,
  noLib: true,
  types: [],
  module: 'ESNext',
  moduleResolution: 'bundler',
  outDir: 'dist',
};
const nativeFiles = {
  'tsconfig.json': { compilerOptions, include: ['src/**/*.ts'] },
  'src/index.ts': 'export const value = 1;',
};
const component =
  '<script lang="ts">export let value: number = 1;</script><div>{value}</div>';

async function fixture(files: Record<string, unknown>, config = {}) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'limina-svelte-route-'));
  const root = realpathSync.native(temporary);
  roots.push(root);
  const file = createFixturePathResolver(root);
  const write = (name: string, value: unknown) => {
    mkdirSync(path.dirname(file(name)), { recursive: true });
    writeFileSync(
      file(name),
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  };
  write('package.json', {
    name: 'route-fixture',
    private: true,
    type: 'module',
    packageManager: 'pnpm@12.10.1',
  });
  write(
    'limina.config.mjs',
    `export default ${JSON.stringify({ cache: false, ...config })};`,
  );
  for (const [name, value] of Object.entries(files)) write(name, value);
  for (const [name, installed] of [
    ['typescript', 'typescript'],
    ['vue-tsc', 'vue-tsc'],
    ['svelte', 'svelte-v4-min'],
    ['svelte2tsx', 'svelte2tsx'],
  ]) {
    mkdirSync(file('node_modules'), { recursive: true });
    symlinkSync(
      path.dirname(requireFromTest.resolve(`${installed}/package.json`)),
      file('node_modules', name!),
      'junction',
    );
  }
  return {
    file,
    write,
    config: await loadConfig({ configPath: file('limina.config.mjs') }),
  };
}

describe('Svelte route exclusion', () => {
  it.each(['auto', 'vue-tsc'] as const)(
    'keeps %s graph authority while avoiding route-only Programs',
    async (checker) => {
      const f = await fixture(
        nativeFiles,
        checker === 'auto'
          ? {}
          : {
              scope: {
                checkers: { [checker]: { include: ['tsconfig.json'] } },
              },
            },
      );
      const metrics = createProfilingMetricsRecorder();
      const manager = new LiminaPreflightManager({ config: f.config, metrics });
      try {
        await expect(manager.hasSvelteCheckProjects()).resolves.toBe(false);
        expect(
          metrics
            .snapshot()
            .filter(({ name }) =>
              [
                'bounded-program-create',
                'typescript-program-create',
                'vue-program-create',
              ].includes(name),
            )
            .reduce((total, metric) => total + metric.count, 0),
        ).toBe(0);
        const graph = await manager.ensureGeneratedGraph();
        expect(
          graph.ownershipPlan.typeConfigs.get(f.file('tsconfig.json'))
            ?.finalOwner,
        ).toBe(checker === 'auto' ? 'tsc' : checker);
        expect(
          metrics
            .snapshot()
            .some(
              ({ name, count }) =>
                name === 'bounded-program-create' && count > 0,
            ),
        ).toBe(true);
        expect(existsSync(f.file('.limina'))).toBe(false);
      } finally {
        manager.dispose();
      }
    },
  );

  it.each([
    {
      name: 'explicit TS-only owner',
      files: nativeFiles,
      config: {
        scope: { checkers: { 'svelte-check': { include: ['tsconfig.json'] } } },
      },
    },
    {
      name: 'selector without existing components',
      files: {
        ...nativeFiles,
        'tsconfig.json': {
          compilerOptions,
          include: ['src/**/*.ts', 'src/**/*.svelte'],
        },
      },
      config: {},
    },
    {
      name: 'nested solution component',
      files: {
        'tsconfig.json': {
          files: [],
          references: [{ path: './nested/tsconfig.json' }],
        },
        'nested/tsconfig.json': { compilerOptions, include: ['src/**/*'] },
        'nested/src/App.svelte': component,
      },
      config: {},
    },
  ])('retains Svelte routing for $name', async ({ files, config }) => {
    const f = await fixture(files, config);
    const manager = new LiminaPreflightManager({ config: f.config });
    try {
      await expect(manager.hasSvelteCheckProjects()).resolves.toBe(true);
      expect(
        (await manager.ensureGeneratedGraph()).checkers.map(({ name }) => name),
      ).toContain('svelte-check');
      expect(existsSync(f.file('.limina'))).toBe(false);
    } finally {
      manager.dispose();
    }
  });

  it('retains dependency promotion from a separate Svelte owner', async () => {
    const f = await fixture({
      'tsconfig.json': {
        files: [],
        references: [
          { path: './consumer/tsconfig.json' },
          { path: './provider/tsconfig.json' },
        ],
      },
      'consumer/tsconfig.json': { compilerOptions, include: ['src/**/*.ts'] },
      'consumer/src/index.ts':
        'import App from "../../provider/src/App.svelte"; export {App};',
      'provider/tsconfig.json': { compilerOptions, include: ['src/**/*'] },
      'provider/src/App.svelte': component,
    });
    const manager = new LiminaPreflightManager({ config: f.config });
    try {
      await expect(manager.hasSvelteCheckProjects()).resolves.toBe(true);
      const owner = (
        await manager.ensureGeneratedGraph()
      ).ownershipPlan.typeConfigs.get(f.file('consumer/tsconfig.json'));
      expect(owner?.finalOwner).toBe('svelte-check');
      expect(owner?.semanticAuthority).toMatchObject({ source: 'dependency' });
    } finally {
      manager.dispose();
    }
  });

  it.each([
    {
      name: 'missing extends',
      files: {
        ...nativeFiles,
        'tsconfig.json': {
          extends: './missing.json',
          compilerOptions,
          include: ['src/**/*.ts'],
        },
      },
      config: {},
      error: /missing.json/,
    },
    {
      name: 'overlapping solution owners',
      files: {
        'tsconfig.json': {
          files: [],
          references: [
            { path: './left/tsconfig.json' },
            { path: './right/tsconfig.json' },
          ],
        },
        'left/tsconfig.json': {
          files: [],
          references: [{ path: '../shared/tsconfig.json' }],
        },
        'right/tsconfig.json': {
          files: [],
          references: [{ path: '../shared/tsconfig.json' }],
        },
        'shared/tsconfig.json': { compilerOptions, include: ['src/**/*.ts'] },
        'shared/src/index.ts': 'export const value = 1;',
      },
      config: {
        scope: {
          checkers: {
            tsc: { include: ['left/tsconfig.json'] },
            'vue-tsc': { include: ['right/tsconfig.json'] },
          },
        },
      },
      error: /Checker ownership conflict/,
    },
  ])('preserves early refusal for $name', async ({ files, config, error }) => {
    const f = await fixture(files, config);
    const manager = new LiminaPreflightManager({ config: f.config });
    try {
      await expect(manager.hasSvelteCheckProjects()).rejects.toThrow(error);
      expect(existsSync(f.file('.limina'))).toBe(false);
    } finally {
      manager.dispose();
    }
  });

  it('recomputes the route after provider generation changes', async () => {
    const f = await fixture({
      ...nativeFiles,
      'tsconfig.json': { compilerOptions, include: ['src/**/*'] },
    });
    const manager = new LiminaPreflightManager({ config: f.config });
    try {
      await expect(manager.hasSvelteCheckProjects()).resolves.toBe(false);
      f.write('src/App.svelte', component);
      createPreflightGenerationController(manager).startNextGeneration();
      await expect(manager.hasSvelteCheckProjects()).resolves.toBe(true);
      expect(
        (await manager.ensureGeneratedGraph()).checkers.map(({ name }) => name),
      ).toContain('svelte-check');
    } finally {
      manager.dispose();
    }
  });

  it.each(['complete', 'producer-build'] as const)(
    'refuses changed Svelte routing before %s materialization',
    async (purpose) => {
      const f = await fixture(
        {
          ...nativeFiles,
          'tsconfig.json': {
            compilerOptions: { ...compilerOptions, typeRoots: ['./src'] },
            include: ['src/**/*'],
          },
        },
        { cache: true },
      );
      const manager = new LiminaPreflightManager({
        config: f.config,
        analysisCache: true,
      });
      try {
        await expect(manager.hasSvelteCheckProjects()).resolves.toBe(false);
        f.write('src/App.svelte', component);
        await expect(
          manager.ensureExecutionArtifactsMaterialized(purpose),
        ).rejects.toThrow('Svelte route inputs changed; rerun the command.');
        const graph =
          purpose === 'complete'
            ? await manager.providers.buildGraph.getGraph()
            : await manager.providers.buildGraph.getProducerBuildPlan();
        for (const file of graph.generatedFiles.keys())
          expect(existsSync(file)).toBe(false);
      } finally {
        manager.dispose();
      }
      const fresh = new LiminaPreflightManager({
        config: f.config,
        analysisCache: true,
      });
      try {
        await expect(fresh.hasSvelteCheckProjects()).resolves.toBe(true);
        const { graph } =
          await fresh.ensureExecutionArtifactsMaterialized(purpose);
        expect(
          graph.governedSources
            .get('svelte-check')
            ?.get(f.file('tsconfig.json'))?.ownedFileNames,
        ).toContain(f.file('src/App.svelte'));
      } finally {
        fresh.dispose();
      }
    },
  );

  it('retains the negative route decision through an actual analysis retry', async () => {
    const f = await fixture(
      {
        ...nativeFiles,
        'tsconfig.json': {
          compilerOptions: { ...compilerOptions, typeRoots: ['./src'] },
          include: ['src/**/*'],
        },
      },
      { cache: true },
    );
    const metrics = createProfilingMetricsRecorder();
    const manager = new LiminaPreflightManager({
      config: f.config,
      metrics,
      analysisCache: true,
    });
    const initialProvider = manager.providers;
    const getGraph = initialProvider.buildGraph.getGraph.bind(
      initialProvider.buildGraph,
    );
    let isGraphCompleted = false;
    let isAdded = false;
    vi.spyOn(initialProvider.buildGraph, 'getGraph').mockImplementation(
      async () => {
        const graph = await getGraph();
        isGraphCompleted = true;
        return graph;
      },
    );
    const assertStable = AnalysisInputs.prototype.assertStable;
    vi.spyOn(AnalysisInputs.prototype, 'assertStable').mockImplementation(
      function (this: AnalysisInputs) {
        if (isGraphCompleted && !isAdded) {
          isAdded = true;
          f.write('src/App.svelte', component);
        }
        assertStable.call(this);
      },
    );
    try {
      await expect(manager.hasSvelteCheckProjects()).resolves.toBe(false);
      await expect(
        manager.ensureGeneratedArtifactsMaterialized(),
      ).rejects.toThrow('Svelte route inputs changed; rerun the command.');
      expect(isAdded).toBe(true);
      expect(manager.providers).not.toBe(initialProvider);
      expect(metrics.snapshot()).toContainEqual(
        expect.objectContaining({
          name: 'analysis-cache',
          kind: 'epoch-retry',
          count: 1,
        }),
      );
      const graph = await manager.providers.buildGraph.getGraph();
      for (const file of graph.generatedFiles.keys())
        expect(existsSync(file)).toBe(false);
      await expect(manager.hasSvelteCheckProjects()).resolves.toBe(true);
      await expect(manager.ensureGeneratedGraph()).rejects.toThrow(
        'Svelte route inputs changed; rerun the command.',
      );
      createPreflightGenerationController(manager).startNextGeneration();
      await expect(manager.hasSvelteCheckProjects()).resolves.toBe(true);
      await expect(
        manager.ensureGeneratedArtifactsMaterialized(),
      ).resolves.toMatchObject({
        graph: { purpose: 'complete' },
      });
    } finally {
      manager.dispose();
    }
  });

  it('preserves the route decision in a pending managed-output refresh', async () => {
    const f = await fixture({
      ...nativeFiles,
      'tsconfig.json': { compilerOptions, include: ['src/**/*'] },
    });
    const manager = new LiminaPreflightManager({
      config: f.config,
      analysisCache: true,
    });
    try {
      await expect(manager.hasSvelteCheckProjects()).resolves.toBe(false);
      const initial = await manager.ensureGeneratedArtifactsMaterialized();
      const before = initial.graph.generatedFiles
        .keys()
        .map((file) => [file, readFileSync(file, 'utf8')] as const)
        .toArray();
      f.write('src/App.svelte', component);
      await expect(manager.refreshAfterManagedOutputs()).rejects.toThrow(
        'Svelte route inputs changed; rerun the command.',
      );
      for (const [file, content] of before)
        expect(readFileSync(file, 'utf8')).toBe(content);
      expect(manager.artifactNamespace.generation).toBe(initial.generation);
    } finally {
      manager.dispose();
    }
  });
});
