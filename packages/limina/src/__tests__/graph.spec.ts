import type { GraphConfig, ResolvedLiminaConfig } from '#config/runner';
import {
  type GeneratedTsconfigGraphResult,
  prepareGeneratedTsconfigGraph,
} from '#core/build-graph/runner';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import { readCheckIssueSnapshot } from '../check-reporting/snapshot';
import { runGraphCheck, type RunGraphCheckOptions } from '../commands/graph';
import { GraphLogger } from '../logger';

const requireFromTest = createRequire(import.meta.url);
const ANSI_ESCAPE = String.fromCodePoint(0x1b);
const ANSI_PATTERN = new RegExp(
  String.raw`${ANSI_ESCAPE}\[[\d:;<=>?]*[\u0020-\u002F]*[\u0040-\u007E]`,
  'gu',
);
const defaultCheckers: NonNullable<ResolvedLiminaConfig['config']>['checkers'] =
  {
    typescript: {
      preset: 'tsc',
      include: ['tsconfig.json', '**/tsconfig.json'],
    },
  };

function stripAnsi(value: string): string {
  return value.replaceAll(ANSI_PATTERN, '');
}

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
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

async function createFixture(
  files: Record<string, string>,
  graph?: GraphConfig,
  checkers: NonNullable<
    ResolvedLiminaConfig['config']
  >['checkers'] = defaultCheckers,
): Promise<{
  cleanup: () => Promise<void>;
  config: ResolvedLiminaConfig;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-graph-')),
  );
  const fixtureFiles = addFixtureEntryConfigs({
    'package.json': stringifyConfig({
      name: 'root',
      private: true,
    }),
    'pnpm-workspace.yaml': 'packages:\n  - app\n  - packages/*\n',
    ...files,
  });

  for (const [relativePath, text] of Object.entries(fixtureFiles)) {
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
        checkers,
      },
      configPath: path.join(rootDir, 'limina.config.mjs'),
      graph,
      rootDir,
    },
    rootDir,
  };
}

async function linkWorkspacePackage(
  rootDir: string,
  importer: string,
  target: string,
  packageName: string,
): Promise<void> {
  const [scope, name] = packageName.split('/');
  const nodeModulesDir =
    scope && name
      ? path.join(rootDir, importer, 'node_modules', scope)
      : path.join(rootDir, importer, 'node_modules');

  await mkdir(nodeModulesDir, {
    recursive: true,
  });
  await symlink(
    path.relative(nodeModulesDir, path.join(rootDir, target)),
    path.join(nodeModulesDir, name ?? packageName),
  );
}

async function linkCompilerSfc(rootDir: string): Promise<void> {
  const compilerPackagePath = requireFromTest.resolve(
    '@vue/compiler-sfc/package.json',
  );
  const nodeModulesDir = path.join(rootDir, 'node_modules', '@vue');

  await mkdir(nodeModulesDir, {
    recursive: true,
  });
  await symlink(
    path.relative(nodeModulesDir, path.dirname(compilerPackagePath)),
    path.join(nodeModulesDir, 'compiler-sfc'),
  );
}

function stringifyConfig(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

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

function typecheckConfig(
  include: string[],
  compilerOptions: Record<string, unknown> = {},
  limina?: unknown,
): string {
  return stringifyConfig({
    ...(limina === undefined
      ? {}
      : {
          liminaOptions: {
            graphRules: Array.isArray(limina) ? limina : [limina],
          },
        }),
    compilerOptions: {
      ...buildCompilerOptions,
      noEmit: true,
      ...compilerOptions,
    },
    include,
  });
}

function buildConfig(options: {
  include: string[];
  compilerOptions?: Record<string, unknown>;
  limina?: unknown;
  references?: string[];
  tsBuildInfoFile: string;
}): string {
  return stringifyConfig({
    ...(options.limina === undefined
      ? {}
      : {
          liminaOptions: {
            graphRules: Array.isArray(options.limina)
              ? options.limina
              : [options.limina],
          },
        }),
    compilerOptions: {
      ...buildCompilerOptions,
      rootDir: '.',
      tsBuildInfoFile: options.tsBuildInfoFile,
      ...options.compilerOptions,
    },
    include: options.include,
    ...(options.references
      ? {
          references: options.references.map((reference) => ({
            path: reference,
          })),
        }
      : {}),
  });
}

function generatedDtsConfig(options: {
  include: string[];
  references?: string[];
  sourceConfig: string;
  tsBuildInfoFile: string;
}): string {
  return stringifyConfig({
    compilerOptions: {
      ...buildCompilerOptions,
      rootDir: '.',
      tsBuildInfoFile: options.tsBuildInfoFile,
    },
    include: options.include,
    liminaOptions: {
      sourceConfig: options.sourceConfig,
    },
    ...(options.references
      ? {
          references: options.references.map((reference) => ({
            path: reference,
          })),
        }
      : {}),
  });
}

function createManualGeneratedGraph(
  rootDir: string,
  entryRelativePath = 'tsconfig.build.json',
): GeneratedTsconfigGraphResult {
  return {
    changed: false,
    checkerEntries: new Map([
      ['typescript', path.join(rootDir, entryRelativePath)],
    ]),
    checkers: [
      {
        exclude: [],
        extensions: [],
        include: [entryRelativePath],
        name: 'typescript',
        preset: 'tsc',
      },
    ],
    configToOutputBuild: new Map(),
    dtsToSource: new Map(),
    generatedKnipConfigs: [],
    generatedKnipDiagnostics: [],
    manifest: {
      checkers: {},
      generatedBy: 'limina',
      knip: {
        diagnostics: [],
        packages: [],
      },
      providerEdges: [],
      version: 2,
    },
    manifestPath: path.join(rootDir, '.limina/manifest.json'),
    outputDeclarationCopies: new Map(),
    providerEdges: [],
    sourceToBuild: new Map(),
    sourceToDts: new Map(),
  };
}

async function runGraphCheckWithIssues(
  config: ResolvedLiminaConfig,
  options: RunGraphCheckOptions = {},
): Promise<{
  issues: NonNullable<RunGraphCheckOptions['issues']>;
  passed: boolean;
}> {
  const issues: NonNullable<RunGraphCheckOptions['issues']> = [];
  const passed = await runGraphCheck(config, {
    clearScreen: false,
    deferSnapshot: true,
    report: {
      defer: true,
    },
    ...options,
    issues,
  });

  return {
    issues,
    passed,
  };
}

function createLocalBoundaryFiles(options: {
  limina?: unknown;
  runtimeReferences?: string[];
  runtimeSource?: string;
}): Record<string, string> {
  return {
    'app/node.ts': 'export const nodeValue = 1;\n',
    'app/runtime.ts':
      options.runtimeSource ??
      "import { nodeValue } from './node';\nexport const runtimeValue = nodeValue;\n",
    'app/tsconfig.node.dts.json': buildConfig({
      include: ['node.ts'],
      tsBuildInfoFile: './.tsbuild/node.tsbuildinfo',
    }),
    'app/tsconfig.node.json': typecheckConfig(['node.ts']),
    'app/tsconfig.runtime.dts.json': buildConfig({
      include: ['runtime.ts'],
      limina: options.limina,
      references: options.runtimeReferences,
      tsBuildInfoFile: './.tsbuild/runtime.tsbuildinfo',
    }),
    'app/tsconfig.runtime.json': typecheckConfig(
      ['runtime.ts'],
      {},
      options.limina,
    ),
    'tsconfig.build.json': stringifyConfig({
      files: [],
      references: [
        {
          path: './app/tsconfig.node.dts.json',
        },
        {
          path: './app/tsconfig.runtime.dts.json',
        },
      ],
    }),
  };
}

function createWorkspacePackageFiles(options: {
  appReferences?: string[];
  appSource: string;
}): Record<string, string> {
  return {
    'packages/app/package.json': stringifyConfig({
      dependencies: {
        '@example/internal': 'workspace:*',
      },
      name: '@example/app',
      type: 'module',
    }),
    'packages/app/src/index.ts': options.appSource,
    'packages/app/tsconfig.lib.dts.json': buildConfig({
      include: ['src/**/*.ts'],
      limina: 'runtime',
      references: options.appReferences,
      tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
    }),
    'packages/app/tsconfig.lib.json': typecheckConfig(
      ['src/**/*.ts'],
      {},
      'runtime',
    ),
    'packages/internal/package.json': stringifyConfig({
      exports: {
        '.': './src/index.ts',
      },
      name: '@example/internal',
      type: 'module',
    }),
    'packages/internal/src/index.ts': 'export const internalValue = 1;\n',
    'packages/internal/tsconfig.lib.dts.json': buildConfig({
      include: ['src/**/*.ts'],
      tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
    }),
    'packages/internal/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
    'pnpm-workspace.yaml': `
packages:
  - packages/*
`,
    'tsconfig.build.json': stringifyConfig({
      files: [],
      references: [
        {
          path: './packages/internal/tsconfig.lib.dts.json',
        },
        {
          path: './packages/app/tsconfig.lib.dts.json',
        },
      ],
    }),
  };
}

function createManagedOutputWorkspacePackageFiles(
  options: {
    appReferences?: string[];
    providerOwnedSource?: boolean;
    providerOutputs?: boolean;
  } = {},
): Record<string, string> {
  const providerOwnedSource = options.providerOwnedSource ?? true;
  const providerOutputs = options.providerOutputs ?? true;

  return {
    'packages/app/package.json': stringifyConfig({
      dependencies: {
        '@example/internal': 'workspace:*',
      },
      name: '@example/app',
      type: 'module',
    }),
    'packages/app/src/index.ts':
      "import { internalValue } from '@example/internal';\nexport const value = internalValue;\n",
    'packages/app/tsconfig.lib.dts.json': buildConfig({
      include: ['src/**/*.ts'],
      references: options.appReferences,
      tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
    }),
    'packages/app/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
    'packages/internal/dist/index.d.ts':
      'export declare const internalValue: number;\n',
    'packages/internal/dist/index.js': 'export const internalValue = 1;\n',
    'packages/internal/package.json': stringifyConfig({
      exports: {
        '.': {
          types: './dist/index.d.ts',
          default: './dist/index.js',
        },
      },
      name: '@example/internal',
      type: 'module',
    }),
    ...(providerOwnedSource
      ? {
          'packages/internal/src/index.ts': 'export const internalValue = 1;\n',
        }
      : {
          'packages/internal/src/other.ts': 'export const otherValue = 1;\n',
        }),
    'packages/internal/tsconfig.lib.dts.json': buildConfig({
      include: ['src/**/*.ts'],
      tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
    }),
    'packages/internal/tsconfig.lib.json': stringifyConfig({
      compilerOptions: {
        ...buildCompilerOptions,
        noEmit: true,
      },
      include: ['src/**/*.ts'],
      ...(providerOutputs
        ? {
            liminaOptions: {
              outputs: {
                rootDir: 'src',
                outDir: 'dist',
              },
            },
          }
        : {}),
    }),
    'pnpm-workspace.yaml': `
packages:
  - packages/*
`,
    'tsconfig.build.json': stringifyConfig({
      files: [],
      references: [
        {
          path: './packages/internal/tsconfig.lib.dts.json',
        },
        {
          path: './packages/app/tsconfig.lib.dts.json',
        },
      ],
    }),
  };
}

const denyNodeRef: GraphConfig = {
  rules: {
    runtime: {
      deny: {
        refs: [
          {
            path: 'app/tsconfig.node.json',
            reason: 'runtime code must not depend on node internals',
          },
        ],
      },
    },
  },
};

const denyInternalDep: GraphConfig = {
  rules: {
    runtime: {
      deny: {
        deps: [
          {
            name: '@example/internal',
            reason: 'runtime package must not consume internal directly',
          },
        ],
      },
    },
  },
};

function createVueWorkspacePackageFiles(options: {
  appReferences?: string[];
  appSource: string;
  limina?: unknown;
}): Record<string, string> {
  return {
    ...createWorkspacePackageFiles({
      appReferences: options.appReferences,
      appSource: 'export const fallback = 1;\n',
    }),
    'packages/app/src/App.vue': options.appSource,
    'packages/app/tsconfig.vue.dts.json': buildConfig({
      include: ['src/**/*.vue'],
      limina: options.limina,
      references: options.appReferences,
      tsBuildInfoFile: './.tsbuild/vue.tsbuildinfo',
    }),
    'packages/app/tsconfig.vue.json': typecheckConfig(
      ['src/**/*.vue'],
      {},
      options.limina,
    ),
    'tsconfig.vue.build.json': stringifyConfig({
      files: [],
      references: [
        {
          path: './packages/internal/tsconfig.lib.dts.json',
        },
        {
          path: './packages/app/tsconfig.vue.dts.json',
        },
      ],
    }),
  };
}

function createVueExportWorkspacePackageFiles(
  options: {
    appReferences?: string[];
  } = {},
): Record<string, string> {
  return {
    'packages/app/package.json': stringifyConfig({
      dependencies: {
        '@example/internal': 'workspace:*',
      },
      name: '@example/app',
      type: 'module',
    }),
    'packages/app/src/App.vue':
      '<script setup lang="ts">\nimport Internal from \'@example/internal\';\nvoid Internal;\n</script>\n',
    'packages/app/tsconfig.vue.dts.json': buildConfig({
      include: ['src/**/*.vue'],
      references: options.appReferences,
      tsBuildInfoFile: './.tsbuild/vue.tsbuildinfo',
    }),
    'packages/app/tsconfig.vue.json': typecheckConfig(['src/**/*.vue']),
    'packages/internal/package.json': stringifyConfig({
      exports: {
        '.': './src/Internal.vue',
      },
      name: '@example/internal',
      type: 'module',
    }),
    'packages/internal/src/Internal.vue':
      '<script setup lang="ts">\nconst value = 1;\nvoid value;\n</script>\n',
    'packages/internal/tsconfig.lib.dts.json': buildConfig({
      include: ['src/**/*.vue'],
      tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
    }),
    'packages/internal/tsconfig.lib.json': typecheckConfig(['src/**/*.vue']),
    'pnpm-workspace.yaml': `
packages:
  - packages/*
`,
    'tsconfig.vue.build.json': stringifyConfig({
      files: [],
      references: [
        {
          path: './packages/internal/tsconfig.lib.dts.json',
        },
        {
          path: './packages/app/tsconfig.vue.dts.json',
        },
      ],
    }),
  };
}

interface ConditionProjectFixture {
  customConditions?: string[];
  name: string;
  references?: string[];
  source: string;
}

function conditionCompilerOptions(
  customConditions: string[] | undefined,
): Record<string, unknown> {
  return customConditions === undefined
    ? {}
    : {
        customConditions,
      };
}

function createConditionDomainFiles(
  projects: ConditionProjectFixture[],
): Record<string, string> {
  const files: Record<string, string> = {
    'tsconfig.build.json': stringifyConfig({
      files: [],
      references: projects.map((project) => ({
        path: `./app/tsconfig.${project.name}.dts.json`,
      })),
    }),
  };

  for (const project of projects) {
    const compilerOptions = conditionCompilerOptions(project.customConditions);

    files[`app/${project.name}.ts`] = project.source;
    files[`app/tsconfig.${project.name}.dts.json`] = buildConfig({
      compilerOptions,
      include: [`${project.name}.ts`],
      references: project.references?.map(
        (reference) => `./tsconfig.${reference}.dts.json`,
      ),
      tsBuildInfoFile: `./.tsbuild/${project.name}.tsbuildinfo`,
    });
    files[`app/tsconfig.${project.name}.json`] = typecheckConfig(
      [`${project.name}.ts`],
      compilerOptions,
    );
  }

  return files;
}

function _createRootWorkspaceDependencyFiles(options: {
  rootDependencies?: Record<string, string>;
  rootSource: string;
  rootTsconfigInclude?: string[];
}): Record<string, string> {
  return {
    'package.json': stringifyConfig({
      devDependencies: options.rootDependencies ?? {
        '@example/internal': 'workspace:*',
      },
      name: '@example/root',
      private: true,
      type: 'module',
    }),
    'packages/internal/package.json': stringifyConfig({
      exports: {
        '.': './src/index.ts',
      },
      name: '@example/internal',
      type: 'module',
    }),
    'packages/internal/src/index.ts':
      'export type InternalValue = number;\nexport const internalValue = 1;\n',
    'packages/internal/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
    'pnpm-workspace.yaml': `
packages:
  - packages/*
`,
    'scripts/index.ts': options.rootSource,
    'tsconfig.build.json': stringifyConfig({
      files: [],
      references: [],
    }),
    'tsconfig.json': typecheckConfig(
      options.rootTsconfigInclude ?? ['scripts/**/*.ts'],
    ),
  };
}

describe('runGraphCheck checker entry', () => {
  it.skip('reports path mapping mismatches between declaration leaves and companions', async () => {
    const fixture = await createFixture({
      'app/src/index.ts': 'export const value = 1;\n',
      'app/tsconfig.lib.dts.json': stringifyConfig({
        compilerOptions: {
          ...buildCompilerOptions,
          baseUrl: '.',
          paths: {
            '@shared': ['./src/dts.ts'],
          },
          rootDir: '.',
          tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
        },
        include: ['src/**/*.ts'],
      }),
      'app/tsconfig.lib.json': stringifyConfig({
        compilerOptions: {
          ...buildCompilerOptions,
          baseUrl: '.',
          noEmit: true,
          paths: {
            '@shared': ['./src/typecheck.ts'],
          },
        },
        include: ['src/**/*.ts'],
      }),
      'tsconfig.build.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './app/tsconfig.lib.dts.json',
          },
        ],
      }),
    });

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it.skip('reports missing graph references from nested aggregators', async () => {
    const fixture = await createFixture({
      'app/src/index.ts': 'export const value = 1;\n',
      'app/tsconfig.lib.dts.json': buildConfig({
        include: ['src/**/*.ts'],
        tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
      }),
      'app/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
      'tsconfig.build.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './tsconfig.lib.build.json',
          },
        ],
      }),
      'tsconfig.lib.build.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './app/tsconfig.lib.dts.json',
          },
          {
            path: './app/tsconfig.missing.build.jsonx',
          },
        ],
      }),
    });

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports generated reference cycles from mutual source imports', async () => {
    const fixture = await createFixture({
      'packages/a/package.json': stringifyConfig({
        dependencies: {
          '@example/b': 'workspace:*',
        },
        name: '@example/a',
        type: 'module',
      }),
      'packages/a/src/index.ts':
        "import { bValue } from '../../b/src/index';\nexport const aValue = bValue;\n",
      'packages/a/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
      'packages/b/package.json': stringifyConfig({
        dependencies: {
          '@example/a': 'workspace:*',
        },
        name: '@example/b',
        type: 'module',
      }),
      'packages/b/src/index.ts':
        "import { aValue } from '../../a/src/index';\nexport const bValue = aValue;\n",
      'packages/b/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
    });

    try {
      const { issues, passed } = await runGraphCheckWithIssues(fixture.config);
      const cycleIssues = issues.filter(
        (issue) => issue.code === LIMINA_CHECK_ISSUE_CODES.graphReferenceCycle,
      );
      const detailText = cycleIssues[0]?.detailLines?.join('\n') ?? '';

      expect(passed).toBe(false);
      expect(cycleIssues).toHaveLength(1);
      expect(detailText).toContain('references in cycle:');
      expect(detailText).toContain('packages/a/tsconfig.lib.dts.json');
      expect(detailText).toContain('packages/b/tsconfig.lib.dts.json');
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports self-cycles in generated declaration references', async () => {
    const fixture = await createFixture({
      'app/self.ts': 'export const self = 1;\n',
      'app/tsconfig.self.dts.json': generatedDtsConfig({
        include: ['self.ts'],
        references: ['./tsconfig.self.dts.json'],
        sourceConfig: './tsconfig.self.json',
        tsBuildInfoFile: './.tsbuild/self.tsbuildinfo',
      }),
      'app/tsconfig.self.json': typecheckConfig(['self.ts']),
      'tsconfig.build.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './app/tsconfig.self.dts.json',
          },
        ],
      }),
    });

    try {
      const { issues, passed } = await runGraphCheckWithIssues(fixture.config, {
        generatedGraphProvider: async () =>
          createManualGeneratedGraph(fixture.rootDir),
      });
      const cycleIssues = issues.filter(
        (issue) => issue.code === LIMINA_CHECK_ISSUE_CODES.graphReferenceCycle,
      );
      const detailText = cycleIssues[0]?.detailLines?.join('\n') ?? '';

      expect(passed).toBe(false);
      expect(cycleIssues).toHaveLength(1);
      expect(cycleIssues[0]?.filePath).toBe('app/tsconfig.self.dts.json');
      expect(detailText).toContain(
        'app/tsconfig.self.dts.json -> app/tsconfig.self.dts.json',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports each generated reference SCC once', async () => {
    const fixture = await createFixture({
      'app/a.ts': 'export const a = 1;\n',
      'app/b.ts': 'export const b = 1;\n',
      'app/c.ts': 'export const c = 1;\n',
      'app/tsconfig.a.dts.json': generatedDtsConfig({
        include: ['a.ts'],
        references: ['./tsconfig.b.dts.json', './tsconfig.c.dts.json'],
        sourceConfig: './tsconfig.a.json',
        tsBuildInfoFile: './.tsbuild/a.tsbuildinfo',
      }),
      'app/tsconfig.a.json': typecheckConfig(['a.ts']),
      'app/tsconfig.b.dts.json': generatedDtsConfig({
        include: ['b.ts'],
        references: ['./tsconfig.c.dts.json'],
        sourceConfig: './tsconfig.b.json',
        tsBuildInfoFile: './.tsbuild/b.tsbuildinfo',
      }),
      'app/tsconfig.b.json': typecheckConfig(['b.ts']),
      'app/tsconfig.c.dts.json': generatedDtsConfig({
        include: ['c.ts'],
        references: ['./tsconfig.a.dts.json'],
        sourceConfig: './tsconfig.c.json',
        tsBuildInfoFile: './.tsbuild/c.tsbuildinfo',
      }),
      'app/tsconfig.c.json': typecheckConfig(['c.ts']),
      'tsconfig.build.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './app/tsconfig.a.dts.json',
          },
          {
            path: './app/tsconfig.b.dts.json',
          },
          {
            path: './app/tsconfig.c.dts.json',
          },
        ],
      }),
    });

    try {
      const { issues, passed } = await runGraphCheckWithIssues(fixture.config, {
        generatedGraphProvider: async () =>
          createManualGeneratedGraph(fixture.rootDir),
      });
      const cycleIssues = issues.filter(
        (issue) => issue.code === LIMINA_CHECK_ISSUE_CODES.graphReferenceCycle,
      );
      const detailText = cycleIssues[0]?.detailLines?.join('\n') ?? '';

      expect(passed).toBe(false);
      expect(cycleIssues).toHaveLength(1);
      expect(detailText).toContain('app/tsconfig.a.dts.json');
      expect(detailText).toContain('app/tsconfig.b.dts.json');
      expect(detailText).toContain('app/tsconfig.c.dts.json');
      expect(detailText).toContain(
        'app/tsconfig.a.dts.json -> app/tsconfig.b.dts.json',
      );
      expect(detailText).toContain(
        'app/tsconfig.a.dts.json -> app/tsconfig.c.dts.json',
      );
      expect(detailText).toContain(
        'app/tsconfig.c.dts.json -> app/tsconfig.a.dts.json',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts acyclic generated declaration references', async () => {
    const fixture = await createFixture({
      'app/app.ts':
        "import { core } from './core';\nexport const app = core;\n",
      'app/core.ts':
        "import { shared } from './shared';\nexport const core = shared;\n",
      'app/shared.ts': 'export const shared = 1;\n',
      'app/tsconfig.app.json': typecheckConfig(['app.ts']),
      'app/tsconfig.core.json': typecheckConfig(['core.ts']),
      'app/tsconfig.shared.json': typecheckConfig(['shared.ts']),
      'tsconfig.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './app/tsconfig.app.json',
          },
          {
            path: './app/tsconfig.core.json',
          },
          {
            path: './app/tsconfig.shared.json',
          },
        ],
      }),
    });

    try {
      const { issues, passed } = await runGraphCheckWithIssues(fixture.config);
      const cycleIssues = issues.filter(
        (issue) => issue.code === LIMINA_CHECK_ISSUE_CODES.graphReferenceCycle,
      );

      expect(passed).toBe(true);
      expect(cycleIssues).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts empty custom conditions across declaration references', async () => {
    const fixture = await createFixture(
      createConditionDomainFiles([
        {
          name: 'dep',
          source: 'export const dep = 1;\n',
          customConditions: [],
        },
        {
          name: 'app',
          references: ['dep'],
          source: "import { dep } from './dep';\nexport const value = dep;\n",
        },
      ]),
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts matching custom conditions across transitive declaration references', async () => {
    const customConditions = ['browser', 'source'];
    const fixture = await createFixture(
      createConditionDomainFiles([
        {
          name: 'leaf',
          source: 'export const leaf = 1;\n',
          customConditions,
        },
        {
          name: 'shared',
          references: ['leaf'],
          source:
            "import { leaf } from './leaf';\nexport const shared = leaf;\n",
          customConditions,
        },
        {
          name: 'app',
          references: ['shared'],
          source:
            "import { shared } from './shared';\nexport const value = shared;\n",
          customConditions,
        },
      ]),
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports direct custom condition mismatches across declaration references', async () => {
    const fixture = await createFixture(
      createConditionDomainFiles([
        {
          name: 'dep',
          source: 'export const dep = 1;\n',
          customConditions: ['node', 'source'],
        },
        {
          name: 'app',
          references: ['dep'],
          source: "import { dep } from './dep';\nexport const value = dep;\n",
          customConditions: ['browser', 'source'],
        },
      ]),
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports transitive custom condition mismatches across declaration references', async () => {
    const fixture = await createFixture(
      createConditionDomainFiles([
        {
          name: 'leaf',
          source: 'export const leaf = 1;\n',
          customConditions: ['node', 'source'],
        },
        {
          name: 'shared',
          references: ['leaf'],
          source:
            "import { leaf } from './leaf';\nexport const shared = leaf;\n",
          customConditions: ['browser', 'source'],
        },
        {
          name: 'app',
          references: ['shared'],
          source:
            "import { shared } from './shared';\nexport const value = shared;\n",
          customConditions: ['browser', 'source'],
        },
      ]),
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reuses custom condition summaries for shared declaration subtrees', async () => {
    const errorSpy = vi
      .spyOn(GraphLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createConditionDomainFiles([
        {
          name: 'leaf',
          source: 'export const leaf = 1;\n',
          customConditions: ['node', 'source'],
        },
        {
          name: 'shared',
          references: ['leaf'],
          source:
            "import { leaf } from './leaf';\nexport const shared = leaf;\n",
          customConditions: ['browser', 'source'],
        },
        {
          name: 'first',
          references: ['shared'],
          source:
            "import { shared } from './shared';\nexport const first = shared;\n",
          customConditions: ['browser', 'source'],
        },
        {
          name: 'second',
          references: ['shared'],
          source:
            "import { shared } from './shared';\nexport const second = shared;\n",
          customConditions: ['browser', 'source'],
        },
      ]),
    );

    try {
      await expect(
        runGraphCheck(fixture.config, {
          clearScreen: false,
        }),
      ).resolves.toBe(false);

      const errorText = errorSpy.mock.calls
        .map((call) => String(call[0]))
        .join('\n');
      const mismatchCount = (
        errorText.match(
          /Custom conditions mismatch in declaration reference tree:/gu,
        ) ?? []
      ).length;

      expect(mismatchCount).toBe(1);
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('accepts matching graph condition domains', async () => {
    const fixture = await createFixture(
      createConditionDomainFiles([
        {
          name: 'dep',
          source: 'export const dep = 1;\n',
          customConditions: ['browser', 'source'],
        },
        {
          name: 'web',
          references: ['dep'],
          source: "import { dep } from './dep';\nexport const value = dep;\n",
          customConditions: ['browser', 'source'],
        },
      ]),
      {
        conditionDomains: [
          {
            customConditions: ['browser', 'source'],
            entry: 'app/tsconfig.web.json',
            name: 'web',
          },
        ],
      },
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports graph condition domain custom condition mismatches', async () => {
    const fixture = await createFixture(
      createConditionDomainFiles([
        {
          name: 'web',
          source: 'export const value = 1;\n',
          customConditions: ['browser', 'source'],
        },
      ]),
      {
        conditionDomains: [
          {
            customConditions: ['node', 'source'],
            entry: 'app/tsconfig.web.dts.json',
            name: 'node',
          },
        ],
      },
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports invalid graph condition domain shapes', async () => {
    const fixture = await createFixture(
      createConditionDomainFiles([
        {
          name: 'app',
          source: 'export const value = 1;\n',
        },
      ]),
      {
        conditionDomains: [
          {
            customConditions: [],
            entry: 'app/tsconfig.app.dts.json',
            name: '',
          },
          {
            customConditions: [],
            entry: '',
            name: 'missing-entry',
          },
          {
            customConditions: [1],
            entry: 'app/tsconfig.app.dts.json',
            name: 'invalid-conditions',
          },
        ],
      } as unknown as GraphConfig,
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports invalid graph condition domain entries', async () => {
    const fixture = await createFixture(
      {
        ...createConditionDomainFiles([
          {
            name: 'app',
            source: 'export const value = 1;\n',
          },
        ]),
        'app/unreachable.ts': 'export const unreachable = 1;\n',
        'app/tsconfig.unreachable.dts.json': buildConfig({
          include: ['unreachable.ts'],
          tsBuildInfoFile: './.tsbuild/unreachable.tsbuildinfo',
        }),
        'app/tsconfig.unreachable.json': typecheckConfig(['unreachable.ts']),
      },
      {
        conditionDomains: [
          {
            customConditions: [],
            entry: 'app/tsconfig.missing.dts.json',
            name: 'missing',
          },
          {
            customConditions: [],
            entry: 'app/tsconfig.app.json',
            name: 'typecheck',
          },
          {
            customConditions: [],
            entry: 'app/tsconfig.unreachable.dts.json',
            name: 'unreachable',
          },
        ],
      },
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows artifact-facing exports when no workspace source import selects them', async () => {
    const fixture = await createFixture({
      'packages/internal/dist/index.d.ts':
        'export declare const value: number;\n',
      'packages/internal/dist/index.js': 'export const value = 1;\n',
      'packages/internal/package.json': stringifyConfig({
        exports: {
          '.': './dist/index.js',
        },
        name: '@example/internal',
        type: 'module',
      }),
      'packages/internal/src/index.ts': 'export const value = 1;\n',
      'packages/internal/tsconfig.lib.dts.json': buildConfig({
        include: ['src/**/*.ts'],
        tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
      }),
      'packages/internal/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
      'pnpm-workspace.yaml': `
packages:
  - packages/*
`,
      'tsconfig.build.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './packages/internal/tsconfig.lib.dts.json',
          },
        ],
      }),
    });

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows workspace imports that resolve through exports to dist declarations', async () => {
    const fixture = await createFixture({
      ...createWorkspacePackageFiles({
        appSource:
          "import { internalValue } from '@example/internal';\nexport const value = internalValue;\n",
      }),
      'packages/internal/dist/index.d.ts':
        'export declare const internalValue: number;\n',
      'packages/internal/dist/index.js': 'export const internalValue = 1;\n',
      'packages/internal/package.json': stringifyConfig({
        exports: {
          '.': './dist/index.js',
        },
        name: '@example/internal',
        type: 'module',
      }),
    });

    try {
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/internal',
        '@example/internal',
      );

      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not require project references for declaration-family package providers', async () => {
    const fixture = await createFixture({
      ...createWorkspacePackageFiles({
        appSource:
          "import { internalValue } from '@example/internal';\nexport const value = internalValue;\n",
      }),
      'packages/internal/package.json': stringifyConfig({
        exports: {
          '.': {
            types: './src/index.d.ts',
          },
        },
        name: '@example/internal',
        type: 'module',
      }),
      'packages/internal/src/index.d.ts':
        'export declare const internalValue: number;\n',
      'packages/internal/tsconfig.lib.dts.json': buildConfig({
        include: ['src/**/*.d.ts'],
        tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
      }),
      'packages/internal/tsconfig.lib.json': typecheckConfig(['src/**/*.d.ts']),
    });

    try {
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/internal',
        '@example/internal',
      );

      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts prepared refs for managed output declaration package providers', async () => {
    const fixture = await createFixture(
      createManagedOutputWorkspacePackageFiles(),
    );

    try {
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/internal',
        '@example/internal',
      );

      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports missing prepared refs for managed output declaration package providers', async () => {
    const fixture = await createFixture(
      createManagedOutputWorkspacePackageFiles(),
    );

    try {
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/internal',
        '@example/internal',
      );

      const generatedGraph = await prepareGeneratedTsconfigGraph(
        fixture.config,
      );
      const appGeneratedConfigPath = path.join(
        fixture.rootDir,
        '.limina/tsconfig/checkers/typescript/projects/packages/app/tsconfig.lib.dts.json',
      );
      const appGeneratedConfig = JSON.parse(
        await readFile(appGeneratedConfigPath, 'utf8'),
      ) as {
        references?: { path: string }[];
      };

      await writeFile(
        appGeneratedConfigPath,
        stringifyConfig({
          ...appGeneratedConfig,
          references: [],
        }),
      );

      const { issues, passed } = await runGraphCheckWithIssues(fixture.config, {
        generatedGraphProvider: async () => generatedGraph,
      });

      expect(passed).toBe(false);
      expect(issues.map((issue) => issue.code)).toContain(
        LIMINA_CHECK_ISSUE_CODES.graphReferenceMissing,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('preserves graph-check declaration boundaries for unattributed output declarations', async () => {
    const fixture = await createFixture(
      createManagedOutputWorkspacePackageFiles({
        providerOwnedSource: false,
      }),
    );

    try {
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/internal',
        '@example/internal',
      );

      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports workspace package exports unresolved by TypeScript', async () => {
    const fixture = await createFixture({
      'packages/internal/package.json': stringifyConfig({
        exports: {
          '.': './src/missing.ts',
        },
        name: '@example/internal',
        type: 'module',
      }),
      'packages/internal/src/index.ts': 'export const value = 1;\n',
      'packages/internal/tsconfig.lib.dts.json': buildConfig({
        include: ['src/**/*.ts'],
        tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
      }),
      'packages/internal/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
      'pnpm-workspace.yaml': `
packages:
  - packages/*
`,
      'tsconfig.build.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './packages/internal/tsconfig.lib.dts.json',
          },
        ],
      }),
    });

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports source package exports unresolved by Oxc', async () => {
    const fixture = await createFixture({
      'packages/internal/package.json': stringifyConfig({
        exports: {
          '.': {
            types: './src/index.ts',
          },
        },
        name: '@example/internal',
        type: 'module',
      }),
      'packages/internal/src/index.ts': 'export const value = 1;\n',
      'packages/internal/tsconfig.lib.dts.json': buildConfig({
        include: ['src/**/*.ts'],
        tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
      }),
      'packages/internal/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
      'pnpm-workspace.yaml': `
packages:
  - packages/*
`,
      'tsconfig.build.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './packages/internal/tsconfig.lib.dts.json',
          },
        ],
      }),
    });

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses TypeScript declaration resolutions for type-only exports unresolved by Oxc', async () => {
    const fixture = await createFixture({
      'packages/internal/package.json': stringifyConfig({
        exports: {
          './types': {
            types: './src/index.d.ts',
          },
        },
        name: '@example/internal',
        type: 'module',
      }),
      'packages/internal/src/index.d.ts':
        'export declare const value: number;\n',
      'packages/internal/tsconfig.lib.dts.json': buildConfig({
        include: ['src/**/*.d.ts'],
        tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
      }),
      'packages/internal/tsconfig.lib.json': typecheckConfig(['src/**/*.d.ts']),
      'pnpm-workspace.yaml': `
packages:
  - packages/*
`,
      'tsconfig.build.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './packages/internal/tsconfig.lib.dts.json',
          },
        ],
      }),
    });

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows runtime JavaScript package exports when governed source does not import them', async () => {
    const runtimeExportNames = [
      'file-00',
      'file-01',
      'file-02',
      'file-03',
      'file-04',
      'file-05',
    ];
    const runtimeExportFiles = Object.fromEntries(
      runtimeExportNames.map((exportName) => [
        `packages/internal/dist/${exportName}.js`,
        'export const value = 1;\n',
      ]),
    );
    const runtimeExports = Object.fromEntries(
      runtimeExportNames.map((exportName, index) => [
        index === 0 ? '.' : `./${exportName}`,
        `./dist/${exportName}.js`,
      ]),
    );
    const fixture = await createFixture({
      ...runtimeExportFiles,
      'packages/internal/package.json': stringifyConfig({
        exports: runtimeExports,
        name: '@example/internal',
        type: 'module',
      }),
      'packages/internal/src/index.ts': 'export const value = 1;\n',
      'packages/internal/tsconfig.lib.dts.json': buildConfig({
        include: ['src/**/*.ts'],
        tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
      }),
      'packages/internal/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
      'pnpm-workspace.yaml': `
packages:
  - packages/*
`,
      'tsconfig.build.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './packages/internal/tsconfig.lib.dts.json',
          },
        ],
      }),
    });

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports governed source imports that use package exports without type entries', async () => {
    const errorSpy = vi
      .spyOn(GraphLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture({
      ...createWorkspacePackageFiles({
        appSource:
          "import { value } from '@example/internal/file-00';\nexport const result = value;\n",
      }),
      'packages/internal/dist/file-00.js': 'export const value = 1;\n',
      'packages/internal/package.json': stringifyConfig({
        exports: {
          './file-00': './dist/file-00.js',
        },
        name: '@example/internal',
        type: 'module',
      }),
    });

    try {
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/internal',
        '@example/internal',
      );

      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
      const errors = errorSpy.mock.calls.join('\n');

      expect(errors).toContain(
        'Workspace source import uses package export without a type entry',
      );

      const snapshot = await readCheckIssueSnapshot(fixture.rootDir);
      const issue = snapshot?.issues.find(
        (item) =>
          item.title ===
          'Workspace source import uses package export without a type entry',
      );

      expect(snapshot?.issues).toContainEqual(
        expect.objectContaining({
          filePath: 'packages/app/src/index.ts',
          packageName: '@example/internal',
          task: 'graph:check',
          title:
            'Workspace source import uses package export without a type entry',
        }),
      );
      expect(issue?.detailLines).toContain(
        '  imported specifier: @example/internal/file-00',
      );
      expect(issue?.detailLines).toContain('  export: ./file-00');
      expect(issue?.detailLines).toContain(
        '  TypeScript resolved file: packages/internal/dist/file-00.js',
      );
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it.skip('requires project references for source package exports selected by workspace imports', async () => {
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appSource:
          "import { internalValue } from '@example/internal';\nexport const value = internalValue;\n",
      }),
    );

    try {
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/internal',
        '@example/internal',
      );

      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it.skip('requires project references for CommonJS workspace imports', async () => {
    const errorSpy = vi
      .spyOn(GraphLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appSource:
          "const internal = require('@example/internal');\nexport const value = internal.internalValue;\n",
      }),
    );

    try {
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/internal',
        '@example/internal',
      );

      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
      const errors = errorSpy.mock.calls.join('\n');

      expect(errors).toContain(
        'Missing project reference for workspace import:',
      );
      expect(errors).toContain(
        '    - packages/app/src/index.ts:1 (kind: commonjs) imports @example/internal',
      );
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('does not require project references for require.resolve workspace imports', async () => {
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appSource:
          "export const internalPath = require.resolve('@example/internal');\n",
      }),
    );

    try {
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/internal',
        '@example/internal',
      );

      const { issues, passed } = await runGraphCheckWithIssues(fixture.config);

      expect(passed).toBe(true);
      expect(issues).not.toContainEqual(
        expect.objectContaining({
          code: LIMINA_CHECK_ISSUE_CODES.graphReferenceMissing,
        }),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts referenced source package exports selected by workspace imports', async () => {
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appReferences: ['../internal/tsconfig.lib.dts.json'],
        appSource:
          "import { internalValue } from '@example/internal';\nexport const value = internalValue;\n",
      }),
    );

    try {
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/internal',
        '@example/internal',
      );

      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts same-engine cross-checker provider edges without TypeScript project references', async () => {
    const fixture = await createFixture(
      {
        'packages/app/src/index.ts':
          "import { themeValue } from '../../theme/src/index';\nexport const value = themeValue;\n",
        'packages/app/tsconfig.json': stringifyConfig({
          files: [],
          references: [
            {
              path: './tsconfig.lib.json',
            },
          ],
        }),
        'packages/app/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
        'packages/theme/src/index.ts': 'export const themeValue = 1;\n',
        'packages/theme/tsconfig.json': typecheckConfig(['src/**/*.ts']),
      },
      undefined,
      {
        typescript: {
          include: ['packages/app/tsconfig.json'],
          preset: 'tsc',
        },
        themeTypescript: {
          include: ['packages/theme/tsconfig.json'],
          preset: 'tsc',
        },
      },
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('expands wildcard package exports before graph reference checks', async () => {
    const fixture = await createFixture({
      ...createWorkspacePackageFiles({
        appReferences: ['../internal/tsconfig.lib.dts.json'],
        appSource:
          "import { featureValue } from '@example/internal/features/a';\nexport const value = featureValue;\n",
      }),
      'packages/internal/package.json': stringifyConfig({
        exports: {
          './features/*': './src/features/*.ts',
        },
        name: '@example/internal',
        type: 'module',
      }),
      'packages/internal/src/features/a.ts': 'export const featureValue = 1;\n',
    });

    try {
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/internal',
        '@example/internal',
      );

      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('skips null wildcard package exports because they deny access', async () => {
    const fixture = await createFixture({
      'packages/internal/package.json': stringifyConfig({
        exports: {
          '.': './src/index.ts',
          './types/internal/*': null,
        },
        name: '@example/internal',
        type: 'module',
      }),
      'packages/internal/src/index.ts': 'export const value = 1;\n',
      'packages/internal/tsconfig.lib.dts.json': buildConfig({
        include: ['src/**/*.ts'],
        tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
      }),
      'packages/internal/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
      'pnpm-workspace.yaml': `
packages:
  - packages/*
`,
      'tsconfig.build.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './packages/internal/tsconfig.lib.dts.json',
          },
        ],
      }),
    });

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows cross-package source references with any declared dependency protocol', async () => {
    const fixture = await createFixture({
      'packages/a/package.json': stringifyConfig({
        dependencies: {
          '@example/b': 'link:../b/dist',
        },
        name: '@example/a',
        type: 'module',
      }),
      'packages/a/src/index.ts':
        "import { value } from '@example/b';\nexport const result = value;\n",
      'packages/a/tsconfig.lib.dts.json': buildConfig({
        include: ['src/**/*.ts'],
        references: ['../b/tsconfig.lib.dts.json'],
        tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
      }),
      'packages/a/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
      'packages/b/package.json': stringifyConfig({
        exports: {
          '.': './src/index.ts',
        },
        name: '@example/b',
        type: 'module',
      }),
      'packages/b/src/index.ts': 'export const value = 1;\n',
      'packages/b/tsconfig.lib.dts.json': buildConfig({
        include: ['src/**/*.ts'],
        tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
      }),
      'packages/b/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
      'pnpm-workspace.yaml': `
packages:
  - packages/*
`,
      'tsconfig.build.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './packages/b/tsconfig.lib.dts.json',
          },
          {
            path: './packages/a/tsconfig.lib.dts.json',
          },
        ],
      }),
    });

    try {
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/a',
        'packages/b',
        '@example/b',
      );

      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts source package exports', async () => {
    const fixture = await createFixture({
      'packages/internal/package.json': stringifyConfig({
        exports: {
          '.': './src/index.ts',
          './package.json': './package.json',
        },
        name: '@example/internal',
        type: 'module',
      }),
      'packages/internal/src/index.ts': 'export const value = 1;\n',
      'packages/internal/tsconfig.lib.dts.json': buildConfig({
        include: ['src/**/*.ts'],
        tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
      }),
      'packages/internal/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
      'pnpm-workspace.yaml': `
packages:
  - packages/*
`,
      'tsconfig.build.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './packages/internal/tsconfig.lib.dts.json',
          },
        ],
      }),
    });

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts tsconfig-owned json package exports', async () => {
    const fixture = await createFixture({
      'packages/internal/package.json': stringifyConfig({
        exports: {
          '.': './src/index.ts',
          './schema.json': './schemas/schema.json',
        },
        name: '@example/internal',
        type: 'module',
      }),
      'packages/internal/schemas/schema.json': '{ "title": "Internal" }\n',
      'packages/internal/src/index.ts': 'export const value = 1;\n',
      'packages/internal/tsconfig.lib.dts.json': buildConfig({
        include: ['src/**/*.ts', 'schemas/schema.json'],
        tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
      }),
      'packages/internal/tsconfig.lib.json': typecheckConfig([
        'src/**/*.ts',
        'schemas/schema.json',
      ]),
      'pnpm-workspace.yaml': `
packages:
  - packages/*
`,
      'tsconfig.build.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './packages/internal/tsconfig.lib.dts.json',
          },
        ],
      }),
    });

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it.skip('requires project references for consumed json package exports', async () => {
    const fixture = await createFixture({
      ...createWorkspacePackageFiles({
        appSource:
          "import schema from '@example/internal/schema.json';\nexport const title = schema.title;\n",
      }),
      'packages/internal/package.json': stringifyConfig({
        exports: {
          '.': './src/index.ts',
          './schema.json': './schemas/schema.json',
        },
        name: '@example/internal',
        type: 'module',
      }),
      'packages/internal/schemas/schema.json': '{ "title": "Internal" }\n',
      'packages/internal/tsconfig.lib.dts.json': buildConfig({
        include: ['src/**/*.ts', 'schemas/schema.json'],
        tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
      }),
      'packages/internal/tsconfig.lib.json': typecheckConfig([
        'src/**/*.ts',
        'schemas/schema.json',
      ]),
    });

    try {
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/internal',
        '@example/internal',
      );

      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not inspect unselected package exports outside checker-reachable tsconfigs', async () => {
    const fixture = await createFixture({
      'packages/internal/package.json': stringifyConfig({
        exports: {
          '.': './src/index.ts',
          './schema.json': './schemas/schema.json',
        },
        name: '@example/internal',
        type: 'module',
      }),
      'packages/internal/schemas/schema.json': '{ "title": "Internal" }\n',
      'packages/internal/src/index.ts': 'export const value = 1;\n',
      'packages/internal/tsconfig.lib.dts.json': buildConfig({
        include: ['src/**/*.ts'],
        tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
      }),
      'packages/internal/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
      'pnpm-workspace.yaml': `
packages:
  - packages/*
`,
      'tsconfig.build.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './packages/internal/tsconfig.lib.dts.json',
          },
        ],
      }),
    });

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it.skip('reports malformed graph reference entries', async () => {
    const fixture = await createFixture({
      'app/src/index.ts': 'export const value = 1;\n',
      'app/tsconfig.lib.dts.json': buildConfig({
        include: ['src/**/*.ts'],
        tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
      }),
      'app/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
      'tsconfig.build.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './app/tsconfig.lib.dts.json',
          },
          {
            pat: './app/tsconfig.other.dts.json',
          },
          {
            path: '',
          },
        ],
      }),
    });

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('runGraphCheck graph rules', () => {
  it('denies imports to configured declaration refs for labeled projects', async () => {
    const fixture = await createFixture(
      createLocalBoundaryFiles({
        limina: 'runtime',
      }),
      denyNodeRef,
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not apply graph rules to unlabeled declaration projects', async () => {
    const fixture = await createFixture(
      createLocalBoundaryFiles({
        runtimeReferences: ['./tsconfig.node.dts.json'],
      }),
      denyNodeRef,
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it.skip('reports invalid declaration project graph rule labels', async () => {
    const fixture = await createFixture(
      createLocalBoundaryFiles({
        limina: '',
        runtimeSource: 'export const runtimeValue = 1;\n',
      }),
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports invalid graph rule entries', async () => {
    const errorSpy = vi
      .spyOn(GraphLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createLocalBoundaryFiles({
        limina: 'runtime',
        runtimeSource: 'export const runtimeValue = 1;\n',
      }),
      {
        rules: {
          runtime: {
            deny: {
              refs: [
                {
                  path: 'app/tsconfig.node.json',
                  reason: '',
                },
              ],
            },
          },
        },
      },
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
      const errors = stripAnsi(errorSpy.mock.calls.join('\n'));

      expect(errors).toContain('Graph check summary');
      expect(errors).toContain('│ Found 1 check issue.');
      expect(errors).toContain('│ Top rules: LIMINA_GRAPH_CONFIG_INVALID (1)');
      expect(errors).toContain('Invalid graph rule config:');
      expect(errors).toContain(
        'field: graph.rules.runtime.deny.refs[0].reason',
      );
      expect(errors).toContain('value: ""');
      expect(errors).toContain(
        'reason: deny.refs reason is required and must be a non-empty string.',
      );

      const snapshot = await readCheckIssueSnapshot(fixture.rootDir);

      expect(snapshot?.issues).toContainEqual(
        expect.objectContaining({
          code: 'LIMINA_GRAPH_CONFIG_INVALID',
          detailLines: expect.arrayContaining(['Invalid graph rule config:']),
          reason:
            'deny.refs reason is required and must be a non-empty string.',
          task: 'graph:check',
          title: 'Invalid graph rule config',
        }),
      );
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('formats thrown graph check errors as summary reports in flow mode', async () => {
    const errorSpy = vi
      .spyOn(GraphLogger, 'error')
      .mockImplementation(() => {});
    const task = {
      fail: vi.fn(),
      info: vi.fn(),
      pass: vi.fn(),
      skip: vi.fn(),
      warn: vi.fn(),
    };
    const flow = {
      interactive: false,
      start: vi.fn(() => task),
    } as unknown as NonNullable<RunGraphCheckOptions['flow']>;
    const fixture = await createFixture({});

    try {
      await expect(
        runGraphCheck(fixture.config, {
          clearScreen: false,
          flow,
          generatedGraphProvider: async () => {
            throw new Error(
              [
                'Unsupported auto checker source file extension:',
                '  scope: packages/create-vite/template-svelte-ts/tsconfig.json',
                '  extension: .svelte',
                '  example: packages/create-vite/template-svelte-ts/src/App.svelte',
                '  reason: auto checker mode can only route TypeScript, JavaScript, JSON, and Vue source scopes.',
                '  fix: move this file to an explicit checker scope or configure config.checkers manually.',
              ].join('\n'),
            );
          },
        }),
      ).resolves.toBe(false);

      const errors = stripAnsi(errorSpy.mock.calls.join('\n'));

      expect(errors).toContain('Graph check summary');
      expect(errors).toContain('│ Found 1 check issue.');
      expect(errors).toContain('│ Top rules: LIMINA_GRAPH_CHECK_FAILED (1)');
      expect(errors).toContain(
        'Unsupported auto checker source file extension:',
      );
      expect(errors).toContain(
        'scope: packages/create-vite/template-svelte-ts/tsconfig.json',
      );
      expect(errors).toContain('extension: .svelte');
      expect(errors).toContain(
        'example: packages/create-vite/template-svelte-ts/src/App.svelte',
      );
      expect(errors).toContain('reason: auto checker mode can only route');
      expect(errors).not.toContain('graph check failed: Unsupported');
      expect(task.fail).toHaveBeenCalledWith('graph check failed');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it.skip('reports extra declaration references not proven by imports', async () => {
    const fixture = await createFixture(
      createLocalBoundaryFiles({
        runtimeReferences: ['./tsconfig.node.dts.json'],
        runtimeSource: 'export const runtimeValue = 1;\n',
      }),
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows extra declaration references documented by graph rules', async () => {
    const fixture = await createFixture(
      createLocalBoundaryFiles({
        limina: 'runtime',
        runtimeReferences: ['./tsconfig.node.dts.json'],
        runtimeSource: 'export const runtimeValue = 1;\n',
      }),
      {
        rules: {
          runtime: {
            allow: {
              refs: [
                {
                  path: 'app/tsconfig.node.json',
                  reason: 'Loaded through generated runtime declarations.',
                },
              ],
            },
          },
        },
      },
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('merges graph rules from multiple declaration labels', async () => {
    const fixture = await createFixture(
      createLocalBoundaryFiles({
        limina: ['runtime', 'generated'],
        runtimeReferences: ['./tsconfig.node.dts.json'],
        runtimeSource: 'export const runtimeValue = 1;\n',
      }),
      {
        rules: {
          generated: {
            allow: {
              refs: [
                {
                  path: 'app/tsconfig.node.json',
                  reason: 'Generated declaration references runtime internals.',
                },
              ],
            },
          },
          runtime: {
            deny: {
              deps: [
                {
                  name: 'node:*',
                  reason: 'runtime code must not import Node builtins',
                },
              ],
            },
          },
        },
      },
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects invalid graph rule allow refs', async () => {
    const fixture = await createFixture(
      createLocalBoundaryFiles({
        limina: 'runtime',
        runtimeSource: 'export const runtimeValue = 1;\n',
      }),
      {
        rules: {
          runtime: {
            allow: {
              refs: [
                {
                  path: 'app/tsconfig.node.json',
                  reason: '',
                },
              ],
            },
          },
        },
      },
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts implicit references not proven by static imports', async () => {
    const fixture = await createFixture({
      'app/node.ts': 'export const nodeValue = 1;\n',
      'app/runtime.ts': 'export const runtimeValue = 1;\n',
      'app/tsconfig.node.json': typecheckConfig(['node.ts']),
      'app/tsconfig.runtime.json': stringifyConfig({
        compilerOptions: {
          ...buildCompilerOptions,
          noEmit: true,
        },
        include: ['runtime.ts'],
        liminaOptions: {
          implicitRefs: [
            {
              path: './tsconfig.node.json',
              reason: 'Loaded by a generated runtime manifest.',
            },
          ],
        },
      }),
    });

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps deny refs authoritative over implicit references', async () => {
    const fixture = await createFixture(
      {
        'app/node.ts': 'export const nodeValue = 1;\n',
        'app/runtime.ts': 'export const runtimeValue = 1;\n',
        'app/tsconfig.node.json': typecheckConfig(['node.ts']),
        'app/tsconfig.runtime.json': stringifyConfig({
          compilerOptions: {
            ...buildCompilerOptions,
            noEmit: true,
          },
          include: ['runtime.ts'],
          liminaOptions: {
            graphRules: ['runtime'],
            implicitRefs: [
              {
                path: './tsconfig.node.json',
                reason: 'Loaded by a generated runtime manifest.',
              },
            ],
          },
        }),
      },
      {
        rules: {
          runtime: {
            deny: {
              refs: [
                {
                  path: 'app/tsconfig.node.json',
                  reason: 'runtime must not depend on node internals',
                },
              ],
            },
          },
        },
      },
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it.skip('keeps deny refs authoritative over allow refs', async () => {
    const fixture = await createFixture(
      createLocalBoundaryFiles({
        limina: 'runtime',
        runtimeReferences: ['./tsconfig.node.dts.json'],
        runtimeSource: 'export const runtimeValue = 1;\n',
      }),
      {
        rules: {
          runtime: {
            allow: {
              refs: [
                {
                  path: 'app/tsconfig.node.json',
                  reason: 'Allowed only when not explicitly denied.',
                },
              ],
            },
            deny: {
              refs: [
                {
                  path: 'app/tsconfig.node.json',
                  reason: 'runtime code must not depend on node internals',
                },
              ],
            },
          },
        },
      },
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects removed deny.workspaceDeps graph rule config', async () => {
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appSource: 'export const value = 1;\n',
      }),
      {
        rules: {
          runtime: {
            deny: {
              workspaceDeps: [
                {
                  name: '@example/internal',
                  reason: 'runtime package must not consume internal directly',
                },
              ],
            },
          },
        },
      } as unknown as GraphConfig,
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects removed deny.nodeBuiltins graph rule config', async () => {
    const fixture = await createFixture(
      createLocalBoundaryFiles({
        limina: 'runtime',
        runtimeSource: 'export const runtimeValue = 1;\n',
      }),
      {
        rules: {
          runtime: {
            deny: {
              nodeBuiltins: [
                {
                  name: 'not-a-node-builtin',
                  reason: 'source check owns Node builtin deny rules',
                },
              ],
            },
          },
        },
      } as unknown as GraphConfig,
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('denies raw third-party package subpath imports configured in deps', async () => {
    const fixture = await createFixture(
      createLocalBoundaryFiles({
        limina: 'runtime',
        runtimeSource:
          "import { z } from 'zod/v4';\nexport const runtimeValue = z;\n",
      }),
      {
        rules: {
          runtime: {
            deny: {
              deps: [
                {
                  name: 'zod',
                  reason: 'runtime code must not import validation packages',
                },
              ],
            },
          },
        },
      },
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('denies raw package.json imports configured in deps', async () => {
    const fixture = await createFixture(
      {
        ...createLocalBoundaryFiles({
          limina: 'runtime',
          runtimeSource:
            "import { internalValue } from '#internal/value';\nexport const runtimeValue = internalValue;\n",
        }),
        'app/package.json': stringifyConfig({
          imports: {
            '#internal/*': './internal/*.ts',
          },
          name: '@example/app',
          type: 'module',
        }),
      },
      {
        rules: {
          runtime: {
            deny: {
              deps: [
                {
                  name: '#internal/*',
                  reason: 'runtime code must not import internal aliases',
                },
              ],
            },
          },
        },
      },
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('denies Node builtin imports configured in deps', async () => {
    const fixture = await createFixture(
      createLocalBoundaryFiles({
        limina: 'runtime',
        runtimeSource:
          "import { readFileSync } from 'node:fs';\nexport const runtimeValue = readFileSync;\n",
      }),
      {
        rules: {
          runtime: {
            deny: {
              deps: [
                {
                  name: 'node:*',
                  reason: 'runtime code must not import Node builtins',
                },
              ],
            },
          },
        },
      },
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('denies package.json imports that resolve to configured declaration refs', async () => {
    const fixture = await createFixture(
      {
        ...createLocalBoundaryFiles({
          limina: 'runtime',
          runtimeSource:
            "import { nodeValue } from '#node';\nexport const runtimeValue = nodeValue;\n",
        }),
        'app/package.json': stringifyConfig({
          imports: {
            '#node': './node.ts',
          },
          name: '@example/app',
          type: 'module',
        }),
      },
      denyNodeRef,
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports graph ref rule targets outside the graph', async () => {
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appSource: 'export const value = 1;\n',
      }),
      {
        rules: {
          runtime: {
            deny: {
              refs: [
                {
                  path: 'packages/app/tsconfig.missing.json',
                  reason: 'missing ref should be rejected',
                },
              ],
            },
          },
        },
      },
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it.skip('denies project references to configured declaration refs', async () => {
    const fixture = await createFixture(
      createLocalBoundaryFiles({
        limina: 'runtime',
        runtimeReferences: ['./tsconfig.node.dts.json'],
        runtimeSource: 'export const runtimeValue = 1;\n',
      }),
      denyNodeRef,
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('denies imports to configured workspace deps', async () => {
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appSource:
          "import { internalValue } from '@example/internal';\nexport const value = internalValue;\n",
      }),
      denyInternalDep,
    );

    try {
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/internal',
        '@example/internal',
      );

      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('denies require.resolve workspace deps configured in deps', async () => {
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appSource:
          "export const internalPath = require.resolve('@example/internal');\n",
      }),
      denyInternalDep,
    );

    try {
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/internal',
        '@example/internal',
      );

      const { issues, passed } = await runGraphCheckWithIssues(fixture.config);

      expect(passed).toBe(false);
      expect(issues).toContainEqual(
        expect.objectContaining({
          code: LIMINA_CHECK_ISSUE_CODES.graphAccessDenied,
          packageName: '@example/internal',
          title: 'Denied graph access',
        }),
      );
      expect(issues).not.toContainEqual(
        expect.objectContaining({
          code: LIMINA_CHECK_ISSUE_CODES.graphReferenceMissing,
        }),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('denies relative imports into configured workspace deps', async () => {
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appSource:
          "import { internalValue } from '../../internal/src/index';\nexport const value = internalValue;\n",
      }),
      denyInternalDep,
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it.skip('denies project references to configured workspace deps', async () => {
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appReferences: ['../internal/tsconfig.lib.dts.json'],
        appSource: 'export const value = 1;\n',
      }),
      denyInternalDep,
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows cross-package relative imports when declaration references are aligned', async () => {
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appReferences: ['../internal/tsconfig.lib.dts.json'],
        appSource:
          "import { internalValue } from '../../internal/src/index';\nexport const value = internalValue;\n",
      }),
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('requires project references for vue package exports selected by vue checker', async () => {
    const fixture = await createFixture(
      createVueExportWorkspacePackageFiles(),
      undefined,
      {
        vue: {
          preset: 'vue-tsc',
          include: [
            'packages/app/tsconfig.json',
            'packages/internal/tsconfig.json',
          ],
        },
      },
    );

    try {
      await linkCompilerSfc(fixture.rootDir);
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/internal',
        '@example/internal',
      );

      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts referenced vue package exports selected by vue checker', async () => {
    const fixture = await createFixture(
      createVueExportWorkspacePackageFiles({
        appReferences: ['../internal/tsconfig.lib.dts.json'],
      }),
      undefined,
      {
        vue: {
          preset: 'vue-tsc',
          include: [
            'packages/app/tsconfig.json',
            'packages/internal/tsconfig.json',
          ],
        },
      },
    );

    try {
      await linkCompilerSfc(fixture.rootDir);
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/internal',
        '@example/internal',
      );

      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows different checker coverage through separate entries', async () => {
    const fixture = await createFixture(
      {
        'packages/ts/tsconfig.json': stringifyConfig({
          files: [],
          references: [
            {
              path: '../shared/tsconfig.json',
            },
          ],
        }),
        'packages/vue/tsconfig.json': stringifyConfig({
          files: [],
          references: [
            {
              path: '../shared/tsconfig.json',
            },
          ],
        }),
        'packages/shared/package.json': stringifyConfig({
          name: '@example/shared',
          version: '0.0.0',
        }),
        'packages/shared/src/a.ts':
          "import { b } from './b';\nexport const a = b;\n",
        'packages/shared/src/b.ts': 'export const b = 1;\n',
        'packages/shared/tsconfig.json': typecheckConfig(['src/**/*.ts']),
      },
      undefined,
      {
        typescript: {
          preset: 'tsc',
          include: ['packages/ts/tsconfig.json'],
        },
        vue: {
          preset: 'vue-tsc',
          include: ['packages/vue/tsconfig.json'],
        },
      },
    );

    try {
      await linkCompilerSfc(fixture.rootDir);

      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('requires project references for workspace imports from Vue scripts', async () => {
    const fixture = await createFixture(
      createVueWorkspacePackageFiles({
        appSource:
          '<script setup lang="ts">\nimport { internalValue } from \'@example/internal\';\nconst value = internalValue;\n</script>\n',
      }),
      undefined,
      {
        vue: {
          preset: 'vue-tsc',
          include: [
            'packages/app/tsconfig.json',
            'packages/internal/tsconfig.json',
          ],
        },
      },
    );

    try {
      await linkCompilerSfc(fixture.rootDir);
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/internal',
        '@example/internal',
      );

      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts referenced workspace imports from Vue scripts', async () => {
    const fixture = await createFixture(
      createVueWorkspacePackageFiles({
        appReferences: ['../internal/tsconfig.lib.dts.json'],
        appSource:
          '<script setup lang="ts">\nimport { internalValue } from \'@example/internal\';\nconst value = internalValue;\n</script>\n',
      }),
      undefined,
      {
        vue: {
          preset: 'vue-tsc',
          include: [
            'packages/app/tsconfig.json',
            'packages/internal/tsconfig.json',
          ],
        },
      },
    );

    try {
      await linkCompilerSfc(fixture.rootDir);
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/internal',
        '@example/internal',
      );

      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('denies graph refs imported from Vue scripts', async () => {
    const fixture = await createFixture(
      createVueWorkspacePackageFiles({
        appReferences: ['../internal/tsconfig.lib.dts.json'],
        appSource:
          '<script setup lang="ts">\nimport { internalValue } from \'@example/internal\';\nconst value = internalValue;\n</script>\n',
        limina: 'runtime',
      }),
      {
        rules: {
          runtime: {
            deny: {
              refs: [
                {
                  path: 'packages/internal/tsconfig.lib.json',
                  reason: 'runtime Vue code must not depend on internal',
                },
              ],
            },
          },
        },
      },
      {
        vue: {
          preset: 'vue-tsc',
          include: [
            'packages/app/tsconfig.json',
            'packages/internal/tsconfig.json',
          ],
        },
      },
    );

    try {
      await linkCompilerSfc(fixture.rootDir);
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/internal',
        '@example/internal',
      );

      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows cross-package relative imports from Vue scripts when declaration references are aligned', async () => {
    const fixture = await createFixture(
      createVueWorkspacePackageFiles({
        appReferences: ['../internal/tsconfig.lib.dts.json'],
        appSource:
          '<script setup lang="ts">\nimport { internalValue } from \'../../internal/src/index\';\nconst value = internalValue;\n</script>\n',
      }),
      undefined,
      {
        vue: {
          preset: 'vue-tsc',
          include: [
            'packages/app/tsconfig.json',
            'packages/internal/tsconfig.json',
          ],
        },
      },
    );

    try {
      await linkCompilerSfc(fixture.rootDir);

      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('collects export-from and dynamic imports from Vue scripts', async () => {
    const fixture = await createFixture(
      createVueWorkspacePackageFiles({
        appSource:
          "<script lang=\"ts\">\nexport { internalValue } from '@example/internal';\nvoid import('@example/internal');\n</script>\n",
      }),
      undefined,
      {
        vue: {
          preset: 'vue-tsc',
          include: [
            'packages/app/tsconfig.json',
            'packages/internal/tsconfig.json',
          ],
        },
      },
    );

    try {
      await linkCompilerSfc(fixture.rootDir);
      await linkWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        'packages/internal',
        '@example/internal',
      );

      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });
});
