import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runGraphCheck } from '../commands/graph';
import type { GraphConfig, ResolvedLiminaConfig } from '../config';

const requireFromTest = createRequire(import.meta.url);

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

async function createFixture(
  files: Record<string, string>,
  graph?: GraphConfig,
  checkers: NonNullable<ResolvedLiminaConfig['config']>['checkers'] = {
    typescript: {
      preset: 'tsc',
      entry: 'tsconfig.build.json',
    },
  },
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
  strict: true,
  target: 'ES2023',
  types: [],
};

function typecheckConfig(include: string[]): string {
  return stringifyConfig({
    compilerOptions: {
      ...buildCompilerOptions,
      noEmit: true,
    },
    include,
  });
}

function buildConfig(options: {
  include: string[];
  limina?: unknown;
  references?: string[];
  tsBuildInfoFile: string;
}): string {
  return stringifyConfig({
    ...(options.limina === undefined ? {} : { limina: options.limina }),
    compilerOptions: {
      ...buildCompilerOptions,
      rootDir: '.',
      tsBuildInfoFile: options.tsBuildInfoFile,
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

describe('runGraphCheck checker entry', () => {
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

  it('reports invalid declaration project limina labels', async () => {
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

  it('keeps cross-package relative import checks active without package dependency rules', async () => {
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appSource:
          "import { internalValue } from '../../internal/src/index';\nexport const value = internalValue;\n",
      }),
    );

    try {
      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
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

  it('keeps cross-package relative import checks active for Vue scripts', async () => {
    const fixture = await createFixture(
      createVueWorkspacePackageFiles({
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

      await expect(runGraphCheck(fixture.config)).resolves.toBe(false);
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
