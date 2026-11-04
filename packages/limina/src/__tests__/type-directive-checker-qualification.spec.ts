import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as versionConditions from '../core/build-graph/checker-version-conditions';
import { hasValidRestoredDeclarationContexts } from '../core/build-graph/declaration-context-candidate';
import { prepareAndMaterializeGeneratedTsconfigGraph } from './helpers/generated-graph';
import { withFixtureGovernanceRoot } from './helpers/governance-root';
import { createSemanticRepairFixture } from './helpers/semantic-repair';

const require = createRequire(import.meta.url);
const nativeRoot = path.dirname(
  require.resolve('@typescript/native-preview/package.json'),
);
const compilerOptions = {
  composite: true,
  module: 'ESNext',
  moduleResolution: 'Bundler',
  target: 'ES2022',
  types: [],
  lib: ['es5'],
};
type Channel = 'source' | 'config' | 'automatic' | 'retained';
type Mapping = 'divergent' | 'equivalent' | 'no-match' | 'ordinary-miss';

async function createFixture(channel: Channel, mapping: Mapping) {
  const directive = '/// <reference types="../b" />\n';
  const source = 'export const result: GlobalValue = {n:1};';
  const isMissing = ['no-match', 'ordinary-miss'].includes(mapping);
  const fixture = await createSemanticRepairFixture({
    'package.json': JSON.stringify({
      name: 'type-directive-workspace',
      private: true,
    }),
    'pnpm-workspace.yaml': 'packages:\n  - a\n  - b\n  - c\n',
    'a/package.json': JSON.stringify({ name: '@example/a', private: true }),
    'a/tsconfig.json': JSON.stringify({
      compilerOptions: {
        ...compilerOptions,
        ...(channel === 'config' && { types: ['../b'] }),
        ...(channel === 'automatic' && {
          types: ['*'],
          typeRoots: ['../b/types'],
        }),
      },
      files: ['index.ts'],
    }),
    'a/index.ts': `${channel === 'source' ? directive : channel === 'retained' ? 'import "./bridge";\n' : ''}${source}`,
    'a/bridge.d.ts': directive,
    'b/package.json': JSON.stringify({
      name: '@example/b',
      private: true,
      types: isMissing ? 'missing.d.ts' : 'v6.d.ts',
      ...(mapping !== 'ordinary-miss' && {
        typesVersions: {
          '>=6.1': { '*': [mapping === 'equivalent' ? 'v6.d.ts' : 'v7.d.ts'] },
          ...(!isMissing && { '*': { '*': ['v6.d.ts'] } }),
        },
      }),
    }),
    'b/types/versioned/package.json': JSON.stringify({
      name: '@example/b',
      private: true,
      types: isMissing ? 'missing.d.ts' : 'v6.d.ts',
      ...(mapping !== 'ordinary-miss' && {
        typesVersions: {
          '>=6.1': { '*': [mapping === 'equivalent' ? 'v6.d.ts' : 'v7.d.ts'] },
          ...(!isMissing && { '*': { '*': ['v6.d.ts'] } }),
        },
      }),
    }),
    'b/tsconfig.json': JSON.stringify({ compilerOptions, files: ['index.ts'] }),
    'b/index.ts': 'export const unused = 1;',
    'c/package.json': JSON.stringify({ name: '@example/c', private: true }),
    'c/tsconfig.json': JSON.stringify({
      files: [],
      references: [
        { path: './tsconfig.v6.json' },
        { path: './tsconfig.v7.json' },
      ],
    }),
    ...Object.fromEntries(
      ['v6', 'v7'].flatMap((version) => [
        [
          `b/${version}.d.ts`,
          `import type {Value} from '../c/${version}'; declare global { interface GlobalValue extends Value {} }`,
        ],
        [
          `b/types/versioned/${version}.d.ts`,
          `import type {Value} from '../../../c/${version}'; declare global { interface GlobalValue extends Value {} }`,
        ],
        [`c/${version}.ts`, 'export interface Value { n: number }'],
        [
          `c/tsconfig.${version}.json`,
          JSON.stringify({ compilerOptions, files: [`${version}.ts`] }),
        ],
      ]),
    ),
  });
  await mkdir(fixture.path('node_modules/@typescript'), { recursive: true });
  await symlink(
    nativeRoot,
    fixture.path('node_modules/@typescript/native-preview'),
    'junction',
  );
  const config = withFixtureGovernanceRoot({
    rootDir: fixture.root,
    configPath: fixture.path('limina.config.mjs'),
    scope: {
      checkers: {
        tsgo: {
          include: ['a/tsconfig.json', 'b/tsconfig.json', 'c/tsconfig.json'],
        },
      },
    },
  });
  return { ...fixture, config };
}

async function updateConsumer(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  options: Record<string, unknown>,
  source: string,
) {
  const file = fixture.path('a/tsconfig.json');
  const config = JSON.parse(await readFile(file, 'utf8'));
  Object.assign(config.compilerOptions, options);
  await writeFile(file, JSON.stringify(config));
  await writeFile(fixture.path('a/index.ts'), source);
}

describe('type directive Checker version qualification', () => {
  it.each(['source', 'config'] as const)(
    'retains the compiler noResolve boundary for %s types',
    async (channel) => {
      const fixture = await createFixture(channel, 'divergent');
      try {
        await updateConsumer(
          fixture,
          { noResolve: true },
          `${channel === 'source' ? '/// <reference types="../b" />\n' : ''}export const result = 1;`,
        );
        if (channel === 'config') {
          await expect(
            prepareAndMaterializeGeneratedTsconfigGraph(fixture.config),
          ).rejects.toThrow('typesVersions selection is not qualified');
        } else {
          const graph = await prepareAndMaterializeGeneratedTsconfigGraph(
            fixture.config,
          );
          expect(graph.dependencyEdges).toEqual([]);
        }
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each(['import', 'require'] as const)(
    'qualifies only the visited exports conditions in type resolution mode %s',
    async (mode) => {
      const fixture = await createFixture('source', 'equivalent');
      try {
        await updateConsumer(
          fixture,
          { module: 'NodeNext', moduleResolution: 'NodeNext' },
          `/// <reference types="@example/b" resolution-mode="${mode}" />\nexport const result: GlobalValue = {n:1};`,
        );
        const file = fixture.path('b/package.json');
        const manifest = JSON.parse(await readFile(file, 'utf8'));
        manifest.exports = {
          '.': {
            import: { 'types@>=6.1': './v7.d.ts', types: './v6.d.ts' },
            require: './v6.d.ts',
          },
        };
        await writeFile(file, JSON.stringify(manifest));
        await mkdir(fixture.path('node_modules/@example'), { recursive: true });
        await symlink(
          fixture.path('b'),
          fixture.path('node_modules/@example/b'),
          'junction',
        );
        if (mode === 'import') {
          await expect(
            prepareAndMaterializeGeneratedTsconfigGraph(fixture.config),
          ).rejects.toThrow('Checker version condition is not qualified');
        } else {
          const graph = await prepareAndMaterializeGeneratedTsconfigGraph(
            fixture.config,
          );
          const entry = graph.checkerEntries.get('tsgo');
          const built = spawnSync(
            process.execPath,
            [
              path.join(nativeRoot, 'bin/tsgo'),
              '-b',
              entry!,
              '--pretty',
              'false',
            ],
            { cwd: fixture.root, encoding: 'utf8', timeout: 15_000 },
          );
          expect(built.status, built.stdout + built.stderr).toBe(0);
        }
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('requalifies a previously admitted unresolved type request on restoration', async () => {
    const fixture = await createFixture('config', 'no-match');
    const legacy = vi
      .spyOn(versionConditions, 'resolveVersionQualifiedTypeDirective')
      .mockReturnValue(undefined);
    try {
      const graph = await prepareAndMaterializeGeneratedTsconfigGraph(
        fixture.config,
      );
      legacy.mockRestore();
      expect(graph.dependencyEdges).toEqual([]);
      expect(
        hasValidRestoredDeclarationContexts(graph, undefined, fixture.root),
      ).toBe(false);
      expect(graph.dependencyAnalysis?.declarationValidation).toMatchObject({
        state: 'unavailable',
        diagnostics: [
          expect.stringContaining('typesVersions selection is not qualified'),
        ],
      });
    } finally {
      legacy.mockRestore();
      await fixture.cleanup();
    }
  });

  it.each<Channel>(['source', 'config', 'automatic', 'retained'])(
    'rejects divergent type branches before materialization: %s',
    async (channel) => {
      const fixture = await createFixture(channel, 'divergent');
      try {
        await expect(
          prepareAndMaterializeGeneratedTsconfigGraph(fixture.config),
        ).rejects.toThrow('typesVersions selection is not qualified');
        expect(existsSync(fixture.path('.limina/tsconfig'))).toBe(false);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each<Channel>(['source', 'config'])(
    'qualifies completed misses before another Checker selects an input: %s',
    async (channel) => {
      const fixture = await createFixture(channel, 'no-match');
      try {
        await expect(
          prepareAndMaterializeGeneratedTsconfigGraph(fixture.config),
        ).rejects.toThrow('typesVersions selection is not qualified');
        expect(existsSync(fixture.path('.limina/tsconfig'))).toBe(false);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each<Channel>(['source', 'config', 'automatic'])(
    'builds equivalent type branches without changing provider ownership: %s',
    async (channel) => {
      const fixture = await createFixture(channel, 'equivalent');
      try {
        const graph = await prepareAndMaterializeGeneratedTsconfigGraph(
          fixture.config,
        );
        expect(
          graph.dependencyEdges.map((edge) => [
            edge.fromConfigPath,
            edge.toConfigPath,
          ]),
        ).toEqual([
          [fixture.path('a/tsconfig.json'), fixture.path('c/tsconfig.v6.json')],
        ]);
        const entry = graph.checkerEntries.get('tsgo');
        expect(entry).toBeDefined();
        const built = spawnSync(
          process.execPath,
          [
            path.join(nativeRoot, 'bin/tsgo'),
            '-b',
            entry!,
            '--pretty',
            'false',
          ],
          { cwd: fixture.root, encoding: 'utf8', timeout: 15_000 },
        );
        expect(built.status, built.stdout + built.stderr).toBe(0);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('leaves an ordinary unresolved type directive to the Checker', async () => {
    const fixture = await createFixture('source', 'ordinary-miss');
    try {
      const graph = await prepareAndMaterializeGeneratedTsconfigGraph(
        fixture.config,
      );
      expect(graph.dependencyEdges).toEqual([]);
      const entry = graph.checkerEntries.get('tsgo');
      const built = spawnSync(
        process.execPath,
        [path.join(nativeRoot, 'bin/tsgo'), '-b', entry!, '--pretty', 'false'],
        { cwd: fixture.root, encoding: 'utf8', timeout: 15_000 },
      );
      expect(built.status).not.toBe(0);
      expect(built.stdout + built.stderr).toContain('TS2688');
    } finally {
      await fixture.cleanup();
    }
  });
});
