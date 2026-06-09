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
import { runGraphCheck, runGraphSync } from '../commands/graph';
import type { GraphConfig, ResolvedLiminaConfig } from '../config';
import { GraphLogger } from '../logger';

const requireFromTest = createRequire(import.meta.url);
const defaultCheckers: NonNullable<ResolvedLiminaConfig['config']>['checkers'] =
  {
    typescript: {
      preset: 'tsc',
      entry: 'tsconfig.build.json',
    },
  };

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
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

  for (const [relativePath, text] of Object.entries(files)) {
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
): string {
  return stringifyConfig({
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
    'app/tsconfig.runtime.json': typecheckConfig(['runtime.ts']),
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
    'packages/app/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
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

const denyNodeRef: GraphConfig = {
  rules: {
    runtime: {
      deny: {
        refs: [
          {
            path: 'app/tsconfig.node.dts.json',
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
    'packages/app/tsconfig.vue.json': typecheckConfig(['src/**/*.vue']),
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
  it('reports path mapping mismatches between declaration leaves and companions', async () => {
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

  it('reports missing graph references from nested aggregators', async () => {
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
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
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
            entry: 'app/tsconfig.web.dts.json',
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

  it('allows artifact-facing exports in strict mode when no workspace source import selects them', async () => {
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
      await expect(
        runGraphCheck({
          ...fixture.config,
          strict: true,
        }),
      ).resolves.toBe(true);
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

  it('reports workspace package exports that TypeScript resolves to runtime JavaScript', async () => {
    const fixture = await createFixture({
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
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('requires project references for source package exports selected by workspace imports', async () => {
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

  it('rejects cross-package build references without workspace protocol dependencies', async () => {
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

      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts source package exports in strict mode', async () => {
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
      await expect(
        runGraphCheck({
          ...fixture.config,
          strict: true,
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts tsconfig-owned json package exports in strict mode', async () => {
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
      await expect(
        runGraphCheck({
          ...fixture.config,
          strict: true,
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('requires project references for consumed json package exports', async () => {
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

  it('does not inspect unselected package exports outside checker-reachable tsconfigs in strict mode', async () => {
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
      await expect(
        runGraphCheck({
          ...fixture.config,
          strict: true,
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports malformed graph reference entries', async () => {
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

  it('reports invalid declaration project graph rule labels', async () => {
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
                  path: 'app/tsconfig.node.dts.json',
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

  it('reports extra declaration references not proven by imports', async () => {
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
                  path: 'app/tsconfig.node.dts.json',
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
                  path: 'app/tsconfig.node.dts.json',
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
                  path: 'app/tsconfig.node.dts.json',
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

  it('keeps deny refs authoritative over allow refs', async () => {
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
                  path: 'app/tsconfig.node.dts.json',
                  reason: 'Allowed only when not explicitly denied.',
                },
              ],
            },
            deny: {
              refs: [
                {
                  path: 'app/tsconfig.node.dts.json',
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
                  path: 'packages/app/tsconfig.missing.dts.json',
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

  it('denies project references to configured declaration refs', async () => {
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

  it('denies project references to configured workspace deps', async () => {
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
          entry: 'tsconfig.vue.build.json',
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

  it('accepts referenced vue package exports selected by vue checker', async () => {
    const fixture = await createFixture(
      createVueExportWorkspacePackageFiles({
        appReferences: ['../internal/tsconfig.lib.dts.json'],
      }),
      undefined,
      {
        vue: {
          preset: 'vue-tsc',
          entry: 'tsconfig.vue.build.json',
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
          entry: 'tsconfig.vue.build.json',
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
          entry: 'tsconfig.vue.build.json',
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
                  path: 'packages/internal/tsconfig.lib.dts.json',
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
          entry: 'tsconfig.vue.build.json',
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
          entry: 'tsconfig.vue.build.json',
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
          entry: 'tsconfig.vue.build.json',
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
});

describe('runGraphSync', () => {
  it('syncs missing references from configured checker entries', async () => {
    const fixture = await createFixture(
      createLocalBoundaryFiles({
        runtimeSource:
          "import { nodeValue } from './node';\nexport const runtimeValue = nodeValue;\n",
      }),
    );

    try {
      const result = await runGraphSync(fixture.config, {
        clearScreen: false,
        cwd: fixture.rootDir,
      });

      expect(result.changed).toBe(true);
      expect(
        await readFile(
          path.join(fixture.rootDir, 'app/tsconfig.runtime.dts.json'),
          'utf8',
        ),
      ).toContain('\n  "references": [');
      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('syncs all declaration leaves reachable from a build solution path', async () => {
    const fixture = await createFixture(
      createLocalBoundaryFiles({
        runtimeSource:
          "import { nodeValue } from './node';\nexport const runtimeValue = nodeValue;\n",
      }),
    );

    try {
      const result = await runGraphSync(fixture.config, {
        clearScreen: false,
        cwd: fixture.rootDir,
        entryPath: 'tsconfig.build.json',
      });

      expect(result).toMatchObject({
        changed: true,
        projectCount: 2,
      });
      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('syncs only the requested declaration leaf path', async () => {
    const fixture = await createFixture(
      createLocalBoundaryFiles({
        runtimeSource:
          "import { nodeValue } from './node';\nexport const runtimeValue = nodeValue;\n",
      }),
    );

    try {
      const result = await runGraphSync(fixture.config, {
        clearScreen: false,
        cwd: path.join(fixture.rootDir, 'app'),
        entryPath: './tsconfig.runtime.dts.json',
      });

      expect(result).toMatchObject({
        changed: true,
        projectCount: 1,
      });
      expect(
        await readFile(
          path.join(fixture.rootDir, 'app/tsconfig.runtime.dts.json'),
          'utf8',
        ),
      ).toContain('"path": "./tsconfig.node.dts.json"');
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts absolute declaration leaf paths', async () => {
    const fixture = await createFixture(
      createLocalBoundaryFiles({
        runtimeSource:
          "import { nodeValue } from './node';\nexport const runtimeValue = nodeValue;\n",
      }),
    );

    try {
      const result = await runGraphSync(fixture.config, {
        clearScreen: false,
        cwd: '/',
        entryPath: path.join(fixture.rootDir, 'app/tsconfig.runtime.dts.json'),
      });

      expect(result.changed).toBe(true);
      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('removes stale references that are not allowed', async () => {
    const fixture = await createFixture(
      createLocalBoundaryFiles({
        runtimeReferences: ['./tsconfig.node.dts.json'],
        runtimeSource: 'export const runtimeValue = 1;\n',
      }),
    );

    try {
      const result = await runGraphSync(fixture.config, {
        clearScreen: false,
        cwd: fixture.rootDir,
        entryPath: 'app/tsconfig.runtime.dts.json',
      });

      expect(result.changed).toBe(true);
      const syncedText = await readFile(
        path.join(fixture.rootDir, 'app/tsconfig.runtime.dts.json'),
        'utf8',
      );

      expect(syncedText).toContain('\n  "references": []');
      expect(syncedText).not.toContain('\n    "references":');
    } finally {
      await fixture.cleanup();
    }
  });

  it('preserves allowed stale references', async () => {
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
                  path: 'app/tsconfig.node.dts.json',
                  reason: 'Generated declarations reference this leaf.',
                },
              ],
            },
          },
        },
      },
    );

    try {
      const before = await readFile(
        path.join(fixture.rootDir, 'app/tsconfig.runtime.dts.json'),
        'utf8',
      );
      const result = await runGraphSync(fixture.config, {
        clearScreen: false,
        cwd: fixture.rootDir,
      });
      const after = await readFile(
        path.join(fixture.rootDir, 'app/tsconfig.runtime.dts.json'),
        'utf8',
      );

      expect(result.changed).toBe(false);
      expect(after).toBe(before);
      await expect(runGraphCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not rewrite references when only order differs', async () => {
    const fixture = await createFixture({
      ...createLocalBoundaryFiles({
        runtimeReferences: [
          './tsconfig.node.b.dts.json',
          './tsconfig.node.dts.json',
        ],
        runtimeSource:
          "import { nodeValue } from './node';\nimport { nodeBValue } from './node-b';\nexport const runtimeValue = nodeValue + nodeBValue;\n",
      }),
      'app/node-b.ts': 'export const nodeBValue = 2;\n',
      'app/tsconfig.node.b.dts.json': buildConfig({
        include: ['node-b.ts'],
        tsBuildInfoFile: './.tsbuild/node-b.tsbuildinfo',
      }),
      'app/tsconfig.node.b.json': typecheckConfig(['node-b.ts']),
      'tsconfig.build.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './app/tsconfig.node.dts.json',
          },
          {
            path: './app/tsconfig.node.b.dts.json',
          },
          {
            path: './app/tsconfig.runtime.dts.json',
          },
        ],
      }),
    });

    try {
      const before = await readFile(
        path.join(fixture.rootDir, 'app/tsconfig.runtime.dts.json'),
        'utf8',
      );
      const result = await runGraphSync(fixture.config, {
        clearScreen: false,
        cwd: fixture.rootDir,
      });
      const after = await readFile(
        path.join(fixture.rootDir, 'app/tsconfig.runtime.dts.json'),
        'utf8',
      );

      expect(result.changed).toBe(false);
      expect(after).toBe(before);
    } finally {
      await fixture.cleanup();
    }
  });
});
