import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { EpochInputs } from '../core/analysis-cache/epoch-inputs';
import { hasValidRestoredDeclarationContexts } from '../core/build-graph/declaration-context-candidate';
import { prepareAndMaterializeGeneratedTsconfigGraph } from './helpers/generated-graph';
import { withFixtureGovernanceRoot } from './helpers/governance-root';
import { createSemanticRepairFixture } from './helpers/semantic-repair';

const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const compilerOptions = {
  composite: true,
  module: 'ESNext',
  moduleResolution: 'Bundler',
  target: 'ES2022',
  types: [],
};

async function fixture(checker: 'tsc' | 'vue-tsc', isAlias: boolean) {
  const isVue = checker === 'vue-tsc';
  const target = isAlias ? 'alias' : 'b';
  const f = await createSemanticRepairFixture({
    'package.json': JSON.stringify({ name: 'mapping-fixture', type: 'module' }),
    'a/tsconfig.json': JSON.stringify({
      compilerOptions,
      files: [isVue ? 'App.vue' : 'index.ts'],
    }),
    'b/tsconfig.json': JSON.stringify({
      compilerOptions,
      files: [isVue ? 'Child.vue' : 'index.ts'],
    }),
    'a/index.ts': `import {value} from '../${target}/index'; export const result: number = value;`,
    'b/index.ts': 'export const value: number = 1;',
    'a/App.vue': `<script setup lang="ts">import Child from '../${target}/Child.vue';</script><template><Child /></template>`,
    'b/Child.vue':
      '<script setup lang="ts">const value = 1;</script><template>{{ value }}</template>',
  });
  await symlink(f.path('b'), f.path('alias'), 'junction');
  if (isVue) {
    await mkdir(f.path('node_modules'), { recursive: true });
    for (const name of ['typescript', 'vue-tsc', 'vue'])
      await symlink(
        path.dirname(require.resolve(`${name}/package.json`)),
        f.path('node_modules', name),
        'junction',
      );
  }
  return {
    ...f,
    config: withFixtureGovernanceRoot({
      rootDir: f.root,
      configPath: f.path('limina.config.mjs'),
      scope: {
        checkers: {
          [checker]: { include: ['a/tsconfig.json', 'b/tsconfig.json'] },
        },
      },
    }),
  };
}

describe('required implementation reference mappings', () => {
  it.each([
    { checker: 'tsc', automatic: false, physicalMember: true },
    { checker: 'vue-tsc', automatic: false, physicalMember: true },
    { checker: 'vue-tsc', automatic: true, physicalMember: false },
    { checker: 'vue-tsc', automatic: true, physicalMember: true },
  ] as const)(
    'selects an exact alias owner: $checker, auto=$automatic, physical member=$physicalMember',
    async ({ checker, automatic, physicalMember }) => {
      const f = await fixture(checker, true);
      try {
        await mkdir(f.path('c'));
        await writeFile(
          f.path('c/tsconfig.json'),
          JSON.stringify({
            compilerOptions: { ...compilerOptions, rootDir: '../alias' },
            files: [
              checker === 'tsc' ? '../alias/index.ts' : '../alias/Child.vue',
            ],
          }),
        );
        f.config.scope!.checkers![checker] = {
          include: ['a/tsconfig.json', 'b/tsconfig.json', 'c/tsconfig.json'],
        };
        if (automatic) {
          f.config.scope!.checkers = { auto: {} };
          await writeFile(
            f.path('a/index.ts'),
            "import Child from '../alias/Child.vue'; export const Component = Child;",
          );
          await writeFile(
            f.path('a/tsconfig.json'),
            JSON.stringify({ compilerOptions, files: ['index.ts'] }),
          );
          await writeFile(
            f.path('b/tsconfig.json'),
            JSON.stringify({
              compilerOptions,
              files: physicalMember ? ['index.ts', 'Child.vue'] : ['index.ts'],
            }),
          );
        }
        const graph = await prepareAndMaterializeGeneratedTsconfigGraph(
          f.config,
        );
        expect(graph.dependencyEdges).toEqual([
          expect.objectContaining({
            toConfigPath: f.path('c/tsconfig.json'),
            resolvedFilePath: f.path(
              'alias',
              checker === 'tsc' ? 'index.ts' : 'Child.vue',
            ),
          }),
        ]);
        await execute(
          process.execPath,
          [
            require.resolve(
              checker === 'tsc'
                ? 'typescript/bin/tsc'
                : 'vue-tsc/bin/vue-tsc.js',
            ),
            '-b',
            graph.checkerEntries.get(checker)!,
            '--pretty',
            'false',
          ],
          { cwd: f.root },
        );
      } finally {
        await f.cleanup();
      }
    },
  );

  it('preserves a later exact member instead of discarding it behind its physical alias', async () => {
    const f = await fixture('tsc', true);
    try {
      await writeFile(
        f.path('b/tsconfig.json'),
        JSON.stringify({
          compilerOptions: { ...compilerOptions, rootDir: '..' },
          files: ['index.ts', '../alias/index.ts'],
        }),
      );
      const graph = await prepareAndMaterializeGeneratedTsconfigGraph(f.config);
      expect(graph.dependencyEdges).toHaveLength(1);
      await execute(
        process.execPath,
        [
          require.resolve('typescript/bin/tsc'),
          '-b',
          graph.checkerEntries.get('tsc')!,
          '--pretty',
          'false',
        ],
        { cwd: f.root },
      );
    } finally {
      await f.cleanup();
    }
  });

  it.each(['tsc', 'vue-tsc'] as const)(
    'rejects an unmapped %s alias before materialization',
    async (checker) => {
      const f = await fixture(checker, true);
      try {
        await expect(
          prepareAndMaterializeGeneratedTsconfigGraph(f.config),
        ).rejects.toThrow('Unproved necessary compilation relation');
        expect(existsSync(f.path('.limina/tsconfig'))).toBe(false);
      } finally {
        await f.cleanup();
      }
    },
  );

  it.each(['tsc', 'vue-tsc'] as const)(
    'keeps %s mapping proof independent of build outputs',
    async (checker) => {
      const f = await fixture(checker, false);
      try {
        const graph = await prepareAndMaterializeGeneratedTsconfigGraph(
          f.config,
        );
        expect(graph.dependencyEdges).toEqual([
          expect.objectContaining({
            fromConfigPath: f.path('a/tsconfig.json'),
            toConfigPath: f.path('b/tsconfig.json'),
            kind: 'declaration-provider',
          }),
        ]);
        const beforeBuild = new EpochInputs();
        expect(
          beforeBuild.run(() => hasValidRestoredDeclarationContexts(graph)),
        ).toBe(true);
        const bin = require.resolve(
          checker === 'tsc' ? 'typescript/bin/tsc' : 'vue-tsc/bin/vue-tsc.js',
        );
        await execute(
          process.execPath,
          [bin, '-b', graph.checkerEntries.get(checker)!, '--pretty', 'false'],
          { cwd: f.root },
        );
        await expect(beforeBuild.assertStable()).resolves.toBeUndefined();
        const epoch = new EpochInputs();
        expect(
          epoch.run(() => hasValidRestoredDeclarationContexts(graph)),
        ).toBe(true);
        const consumer = graph.sourceToDts
          .get(checker)!
          .get(f.path('a/tsconfig.json'))!;
        const buildInfo = f.parse(path.relative(f.root, consumer)).options
          .tsBuildInfoFile!;
        // Incremental state is a build output, never an input to mapping proof.
        await writeFile(buildInfo, `${readFileSync(buildInfo, 'utf8')} `);
        await expect(epoch.assertStable()).resolves.toBeUndefined();
      } finally {
        await f.cleanup();
      }
    },
  );

  it.each(['tsc', 'vue-tsc'] as const)(
    'revalidates %s restored input mappings despite previous admission',
    async (checker) => {
      const f = await fixture(checker, false);
      try {
        const graph = await prepareAndMaterializeGeneratedTsconfigGraph(
          f.config,
        );
        expect(hasValidRestoredDeclarationContexts(graph)).toBe(true);
        const provider = graph.sourceToDts
          .get(checker)!
          .get(f.path('b/tsconfig.json'))!;
        const json = JSON.parse(graph.generatedFiles.get(provider)!) as {
          files: string[];
          compilerOptions: { rootDir: string };
        };
        // Same physical source, different compiler key; no source or obligation changes.
        json.files = [
          f.path('alias', checker === 'tsc' ? 'index.ts' : 'Child.vue'),
        ];
        json.compilerOptions.rootDir = f.path('alias');
        graph.generatedFiles = new Map(graph.generatedFiles).set(
          provider,
          JSON.stringify(json),
        );
        expect(graph.dependencyAnalysis?.declarationValidation?.state).toBe(
          'admitted',
        );
        expect(hasValidRestoredDeclarationContexts(graph)).toBe(false);
        expect(
          graph.dependencyAnalysis?.declarationValidation?.diagnostics.join(
            '\n',
          ),
        ).toContain(
          'Required compilation input is not covered by the compiler reference mapping',
        );
      } finally {
        await f.cleanup();
      }
    },
  );
});
