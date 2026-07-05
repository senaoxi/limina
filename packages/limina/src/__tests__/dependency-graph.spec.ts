import type { ResolvedLiminaConfig } from '#config/runner';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectDependencyGraph,
  type DependencyGraphDocument,
  type DependencyGraphEdgeKind,
} from '../dependency-graph/runner';

const defaultCheckers: NonNullable<ResolvedLiminaConfig['config']>['checkers'] =
  {
    typescript: {
      include: ['tsconfig.json', '**/tsconfig.json'],
      preset: 'tsc',
    },
  };

const buildCompilerOptions = {
  composite: true,
  declaration: true,
  emitDeclarationOnly: true,
  incremental: true,
  module: 'ESNext',
  moduleResolution: 'bundler',
  noEmit: false,
  outDir: './.tsbuild',
  resolveJsonModule: true,
  strict: true,
  target: 'ES2023',
  types: [],
};

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

function stringifyConfig(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isFixtureSourceLeafConfig(relativePath: string): boolean {
  const fileName = path.posix.basename(relativePath);

  return (
    /^tsconfig(?:\..+)?\.json$/u.test(fileName) &&
    fileName !== 'tsconfig.json' &&
    !/\.dts\.json$/u.test(fileName) &&
    !/\.build\.json$/u.test(fileName) &&
    !/\.base\.json$/u.test(fileName) &&
    !/\.check\.json$/u.test(fileName)
  );
}

function addFixtureEntryConfigs(
  files: Record<string, string>,
): Record<string, string> {
  const output = { ...files };
  const referencesByDirectory = new Map<string, string[]>();

  for (const relativePath of Object.keys(files)) {
    if (!isFixtureSourceLeafConfig(relativePath)) {
      continue;
    }

    const directory = path.posix.dirname(relativePath);
    const references = referencesByDirectory.get(directory) ?? [];

    references.push(`./${path.posix.basename(relativePath)}`);
    referencesByDirectory.set(directory, references);
  }

  for (const [directory, references] of referencesByDirectory) {
    const entryPath =
      directory === '.'
        ? 'tsconfig.json'
        : path.posix.join(directory, 'tsconfig.json');

    if (Object.hasOwn(output, entryPath)) {
      continue;
    }

    output[entryPath] = stringifyConfig({
      files: [],
      references: references.sort().map((reference) => ({ path: reference })),
    });
  }

  return output;
}

async function createFixture(files: Record<string, string>): Promise<{
  cleanup: () => Promise<void>;
  config: ResolvedLiminaConfig;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-dependency-graph-')),
  );

  await writeText(
    path.join(rootDir, 'pnpm-workspace.yaml'),
    'packages:\n  - packages/*\n',
  );
  await writeText(
    path.join(rootDir, 'package.json'),
    stringifyConfig({
      name: 'root',
      private: true,
    }),
  );

  for (const [relativePath, text] of Object.entries(
    addFixtureEntryConfigs(files),
  )) {
    await writeText(path.join(rootDir, relativePath), text);
  }

  return {
    cleanup: async () => {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    },
    config: {
      config: {
        checkers: defaultCheckers,
      },
      configPath: path.join(rootDir, 'limina.config.mjs'),
      rootDir,
    },
    rootDir,
  };
}

function createPackageJson(
  name: string,
  options: {
    dependencies?: Record<string, string>;
    exports?: unknown;
  } = {},
): string {
  return stringifyConfig({
    dependencies: options.dependencies,
    exports: options.exports,
    name,
    type: 'module',
  });
}

function typecheckBuildConfig(include: string[]): string {
  return stringifyConfig({
    compilerOptions: {
      ...buildCompilerOptions,
      noEmit: true,
    },
    include,
  });
}

function findEdge(
  graph: DependencyGraphDocument,
  from: string,
  to: string,
  kind: DependencyGraphEdgeKind,
) {
  return graph.edges.find(
    (edge) => edge.from === from && edge.to === to && edge.kind === kind,
  );
}

describe('collectDependencyGraph', () => {
  it('allows unrelated nameless workspace packages', async () => {
    const fixture = await createFixture({
      'packages/a/package.json': createPackageJson('@example/a'),
      'packages/a/src/index.ts': 'export const value = 1;\n',
      'packages/a/tsconfig.lib.json': typecheckBuildConfig(['src/**/*.ts']),
      'packages/fixture/package.json': stringifyConfig({
        private: true,
        type: 'module',
      }),
      'packages/fixture/src/index.ts': 'export const fixtureValue = 1;\n',
      'packages/fixture/tsconfig.lib.json': typecheckBuildConfig([
        'src/**/*.ts',
      ]),
    });

    try {
      const graph = await collectDependencyGraph(fixture.config);

      expect(graph.nodes.some((node) => node.path === 'packages/fixture')).toBe(
        false,
      );
      expect(graph.edges).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects dependency graph edges that target nameless workspace packages', async () => {
    const fixture = await createFixture({
      'packages/app/package.json': createPackageJson('@example/app'),
      'packages/app/src/index.ts':
        "import { fixtureValue } from '../../fixture/src/index';\nexport const value = fixtureValue;\n",
      'packages/app/tsconfig.lib.json': typecheckBuildConfig(['src/**/*.ts']),
      'packages/fixture/package.json': stringifyConfig({
        private: true,
        type: 'module',
      }),
      'packages/fixture/src/index.ts': 'export const fixtureValue = 1;\n',
      'packages/fixture/tsconfig.lib.json': typecheckBuildConfig([
        'src/**/*.ts',
      ]),
    });

    try {
      await expect(collectDependencyGraph(fixture.config)).rejects.toThrow(
        /Dependency graph package identity requires package\.json name:[\s\S]*role: target/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('exports source edges when imports resolve to source entries', async () => {
    const fixture = await createFixture({
      'packages/a/package.json': createPackageJson('@example/a', {
        dependencies: {
          '@example/b': 'link:../b/dist',
        },
      }),
      'packages/a/src/index.ts':
        "import { sourceValue } from '@example/b';\nexport const value = sourceValue;\n",
      'packages/a/tsconfig.lib.json': typecheckBuildConfig(['src/**/*.ts']),
      'packages/b/package.json': createPackageJson('@example/b', {
        exports: {
          '.': './src/index.ts',
        },
      }),
      'packages/b/src/index.ts': 'export const sourceValue = 1;\n',
      'packages/b/tsconfig.lib.json': typecheckBuildConfig(['src/**/*.ts']),
    });

    try {
      const graph = await collectDependencyGraph(fixture.config);
      const edge = findEdge(
        graph,
        'pkg:@example/a',
        'pkg:@example/b',
        'source',
      );

      expect(edge).toMatchObject({
        evidence: [
          {
            importer: 'packages/a/src/index.ts',
            resolvedPath: 'packages/b/src/index.ts',
            specifier: '@example/b',
          },
        ],
      });
      expect(
        findEdge(graph, 'pkg:@example/a', 'pkg:@example/b', 'artifact'),
      ).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  it('exports source edges for require.resolve imports', async () => {
    const fixture = await createFixture({
      'packages/a/package.json': createPackageJson('@example/a', {
        dependencies: {
          '@example/b': 'link:../b/dist',
        },
      }),
      'packages/a/src/index.ts':
        "export const sourcePath = require.resolve('@example/b');\n",
      'packages/a/tsconfig.lib.json': typecheckBuildConfig(['src/**/*.ts']),
      'packages/b/package.json': createPackageJson('@example/b', {
        exports: {
          '.': './src/index.ts',
        },
      }),
      'packages/b/src/index.ts': 'export const sourceValue = 1;\n',
      'packages/b/tsconfig.lib.json': typecheckBuildConfig(['src/**/*.ts']),
    });

    try {
      const graph = await collectDependencyGraph(fixture.config);
      const edge = findEdge(
        graph,
        'pkg:@example/a',
        'pkg:@example/b',
        'source',
      );

      expect(edge).toMatchObject({
        evidence: [
          {
            importer: 'packages/a/src/index.ts',
            resolvedPath: 'packages/b/src/index.ts',
            specifier: '@example/b',
          },
        ],
      });
      expect(
        findEdge(graph, 'pkg:@example/a', 'pkg:@example/b', 'artifact'),
      ).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  it('exports artifact edges when imports resolve to artifact entries', async () => {
    const fixture = await createFixture({
      'packages/a/package.json': createPackageJson('@example/a', {
        dependencies: {
          '@example/b': '^1.0.0',
        },
      }),
      'packages/a/src/index.ts':
        "import { runtimeValue } from '@example/b/runtime';\nexport const value = runtimeValue;\n",
      'packages/a/tsconfig.lib.json': typecheckBuildConfig(['src/**/*.ts']),
      'packages/b/dist/runtime.d.ts':
        'export declare const runtimeValue = 1;\n',
      'packages/b/dist/runtime.js': 'export const runtimeValue = 1;\n',
      'packages/b/package.json': createPackageJson('@example/b', {
        exports: {
          './runtime': {
            default: './dist/runtime.js',
            types: './dist/runtime.d.ts',
          },
        },
      }),
      'packages/b/src/index.ts': 'export const sourceValue = 1;\n',
      'packages/b/tsconfig.lib.json': typecheckBuildConfig(['src/**/*.ts']),
    });

    try {
      const graph = await collectDependencyGraph(fixture.config);
      const edge = findEdge(
        graph,
        'pkg:@example/a',
        'pkg:@example/b',
        'artifact',
      );

      expect(edge).toMatchObject({
        evidence: [
          {
            importer: 'packages/a/src/index.ts',
            resolvedPath: 'packages/b/dist/runtime.js',
            specifier: '@example/b/runtime',
          },
        ],
      });
      expect(
        findEdge(graph, 'pkg:@example/a', 'pkg:@example/b', 'source'),
      ).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  it('exports artifact edges for type-only declaration artifacts', async () => {
    const fixture = await createFixture({
      'packages/a/package.json': createPackageJson('@example/a', {
        dependencies: {
          '@example/b': 'workspace:*',
        },
      }),
      'packages/a/src/index.ts':
        "import type { RuntimeValue } from '@example/b/types';\nexport type Value = RuntimeValue;\n",
      'packages/a/tsconfig.lib.json': typecheckBuildConfig(['src/**/*.ts']),
      'packages/b/dist/types.d.ts':
        'export interface RuntimeValue { ready: true }\n',
      'packages/b/package.json': createPackageJson('@example/b', {
        exports: {
          './types': {
            types: './dist/types.d.ts',
          },
        },
      }),
      'packages/b/src/index.ts': 'export const sourceValue = 1;\n',
      'packages/b/tsconfig.lib.json': typecheckBuildConfig(['src/**/*.ts']),
    });

    try {
      const graph = await collectDependencyGraph(fixture.config);

      expect(
        findEdge(graph, 'pkg:@example/a', 'pkg:@example/b', 'artifact'),
      ).toMatchObject({
        evidence: [
          {
            resolvedPath: 'packages/b/dist/types.d.ts',
            specifier: '@example/b/types',
          },
        ],
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not export edges for unused artifact exports', async () => {
    const fixture = await createFixture({
      'packages/a/package.json': createPackageJson('@example/a', {
        dependencies: {
          '@example/b': 'workspace:*',
        },
      }),
      'packages/a/src/index.ts': 'export const value = 1;\n',
      'packages/a/tsconfig.lib.json': typecheckBuildConfig(['src/**/*.ts']),
      'packages/b/dist/runtime.d.ts':
        'export declare const runtimeValue = 1;\n',
      'packages/b/dist/runtime.js': 'export const runtimeValue = 1;\n',
      'packages/b/package.json': createPackageJson('@example/b', {
        exports: {
          './runtime': {
            default: './dist/runtime.js',
            types: './dist/runtime.d.ts',
          },
        },
      }),
      'packages/b/src/index.ts': 'export const sourceValue = 1;\n',
      'packages/b/tsconfig.lib.json': typecheckBuildConfig(['src/**/*.ts']),
    });

    try {
      const graph = await collectDependencyGraph(fixture.config);

      expect(graph.edges).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('filters source and artifact views', async () => {
    const fixture = await createFixture({
      'packages/a/package.json': createPackageJson('@example/a', {
        dependencies: {
          '@example/b': 'workspace:*',
          '@example/c': 'workspace:*',
        },
      }),
      'packages/a/src/index.ts':
        "import { sourceValue } from '@example/b';\nimport { runtimeValue } from '@example/c/runtime';\nexport const value = sourceValue + runtimeValue;\n",
      'packages/a/tsconfig.lib.json': typecheckBuildConfig(['src/**/*.ts']),
      'packages/b/package.json': createPackageJson('@example/b', {
        exports: {
          '.': './src/index.ts',
        },
      }),
      'packages/b/src/index.ts': 'export const sourceValue = 1;\n',
      'packages/b/tsconfig.lib.json': typecheckBuildConfig(['src/**/*.ts']),
      'packages/c/dist/runtime.d.ts':
        'export declare const runtimeValue = 1;\n',
      'packages/c/dist/runtime.js': 'export const runtimeValue = 1;\n',
      'packages/c/package.json': createPackageJson('@example/c', {
        exports: {
          './runtime': {
            default: './dist/runtime.js',
            types: './dist/runtime.d.ts',
          },
        },
      }),
      'packages/c/src/index.ts': 'export const sourceValue = 1;\n',
      'packages/c/tsconfig.lib.json': typecheckBuildConfig(['src/**/*.ts']),
    });

    try {
      const sourceGraph = await collectDependencyGraph(fixture.config, {
        view: 'source',
      });
      const artifactGraph = await collectDependencyGraph(fixture.config, {
        view: 'artifact',
      });

      expect(sourceGraph.edges.map((edge) => edge.kind)).toEqual(['source']);
      expect(artifactGraph.edges.map((edge) => edge.kind)).toEqual([
        'artifact',
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('exports artifact cycles as graph facts instead of failures', async () => {
    const fixture = await createFixture({
      'packages/a/dist/runtime.d.ts':
        'export declare const aRuntimeValue = 1;\n',
      'packages/a/dist/runtime.js': 'export const aRuntimeValue = 1;\n',
      'packages/a/package.json': createPackageJson('@example/a', {
        dependencies: {
          '@example/b': 'workspace:*',
        },
        exports: {
          './runtime': {
            default: './dist/runtime.js',
            types: './dist/runtime.d.ts',
          },
        },
      }),
      'packages/a/src/index.ts':
        "import { bRuntimeValue } from '@example/b/runtime';\nexport const value = bRuntimeValue;\n",
      'packages/a/tsconfig.lib.json': typecheckBuildConfig(['src/**/*.ts']),
      'packages/b/dist/runtime.d.ts':
        'export declare const bRuntimeValue = 1;\n',
      'packages/b/dist/runtime.js': 'export const bRuntimeValue = 1;\n',
      'packages/b/package.json': createPackageJson('@example/b', {
        dependencies: {
          '@example/a': 'workspace:*',
        },
        exports: {
          './runtime': {
            default: './dist/runtime.js',
            types: './dist/runtime.d.ts',
          },
        },
      }),
      'packages/b/src/index.ts':
        "import { aRuntimeValue } from '@example/a/runtime';\nexport const value = aRuntimeValue;\n",
      'packages/b/tsconfig.lib.json': typecheckBuildConfig(['src/**/*.ts']),
    });

    try {
      const graph = await collectDependencyGraph(fixture.config, {
        view: 'artifact',
      });

      expect(graph.edges).toHaveLength(2);
      expect(
        findEdge(graph, 'pkg:@example/a', 'pkg:@example/b', 'artifact'),
      ).toBeDefined();
      expect(
        findEdge(graph, 'pkg:@example/b', 'pkg:@example/a', 'artifact'),
      ).toBeDefined();
    } finally {
      await fixture.cleanup();
    }
  });
});
