import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runSourceCheck } from '../commands/source';
import type {
  GraphConfig,
  ResolvedLiminaConfig,
  SourceBoundaryConfig,
} from '../config';
import { SourceLogger } from '../logger';

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

async function createFixture(
  files: Record<string, string>,
  options:
    | GraphConfig
    | { graph?: GraphConfig; source?: SourceBoundaryConfig } = {},
): Promise<{
  cleanup: () => Promise<void>;
  config: ResolvedLiminaConfig;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-source-')),
  );

  for (const [relativePath, text] of Object.entries(files)) {
    await writeText(path.join(rootDir, relativePath), text);
  }

  const hasOptionsShape =
    Object.hasOwn(options, 'graph') || Object.hasOwn(options, 'source');
  const graph = hasOptionsShape
    ? (options as { graph?: GraphConfig }).graph
    : (options as GraphConfig);
  const source = hasOptionsShape
    ? (options as { source?: SourceBoundaryConfig }).source
    : undefined;

  return {
    cleanup: async () => {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    },
    config: {
      config: {
        checkers: {
          typescript: {
            preset: 'tsc',
            entry: 'tsconfig.build.json',
          },
        },
        source,
      },
      configPath: path.join(rootDir, 'limina.config.mjs'),
      graph,
      rootDir,
    },
    rootDir,
  };
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

function typecheckConfig(
  include: string[],
  compilerOptions?: Record<string, unknown>,
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
  compilerOptions?: Record<string, unknown>;
  include: string[];
  limina?: unknown;
  tsBuildInfoFile?: string;
}): string {
  return stringifyConfig({
    ...(options.limina === undefined
      ? {}
      : {
          liminaOptions: {
            graphRules: [options.limina],
          },
        }),
    compilerOptions: {
      ...buildCompilerOptions,
      rootDir: '.',
      tsBuildInfoFile: options.tsBuildInfoFile ?? './.tsbuild/lib.tsbuildinfo',
      ...options.compilerOptions,
    },
    include: options.include,
  });
}

function createPackageFixture(options: {
  graph?: { limina?: string };
  manifest?: Record<string, unknown>;
  source: string;
}): Record<string, string> {
  return {
    'app/package.json': stringifyConfig({
      name: '@example/app',
      type: 'module',
      ...options.manifest,
    }),
    'app/src/index.ts': options.source,
    'app/tsconfig.lib.dts.json': buildConfig({
      include: ['src/**/*.ts'],
      limina: options.graph?.limina,
    }),
    'app/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
    'tsconfig.build.json': stringifyConfig({
      files: [],
      references: [
        {
          path: './app/tsconfig.lib.dts.json',
        },
      ],
    }),
  };
}

function createNodeModulePackage(
  packageName: string,
  declarations: string,
): Record<string, string> {
  const packageDirectory = `app/node_modules/${packageName}`;

  return {
    [`${packageDirectory}/index.d.ts`]: declarations,
    [`${packageDirectory}/package.json`]: stringifyConfig({
      name: packageName,
      type: 'module',
      types: './index.d.ts',
    }),
  };
}

function createWorkspacePackageFiles(options: {
  appManifest?: Record<string, unknown>;
  appSource: string;
}): Record<string, string> {
  return {
    'packages/app/package.json': stringifyConfig({
      dependencies: {
        '@example/internal': 'workspace:*',
      },
      name: '@example/app',
      type: 'module',
      ...options.appManifest,
    }),
    'packages/app/src/index.ts': options.appSource,
    'packages/app/tsconfig.lib.dts.json': buildConfig({
      include: ['src/**/*.ts'],
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
    'packages/internal/src/index.ts':
      'export type InternalValue = number;\nexport const internalValue = 1;\n',
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

function createRootWorkspaceDependencyFiles(options: {
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

describe('runSourceCheck package authority', () => {
  it('rejects external bare imports that are not declared by the nearest owner', async () => {
    const fixture = await createFixture(
      createPackageFixture({
        source: "import { z } from 'zod';\nexport const schema = z.string();\n",
      }),
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows resolved artifact bare imports declared in any dependency section', async () => {
    const fixture = await createFixture({
      ...createPackageFixture({
        manifest: {
          dependencies: {
            'dep-pkg': '^1.0.0',
          },
          devDependencies: {
            'dev-pkg': '^1.0.0',
          },
          optionalDependencies: {
            'optional-pkg': '^1.0.0',
          },
          peerDependencies: {
            'peer-pkg': '^1.0.0',
          },
        },
        source:
          "import type { Dep } from 'dep-pkg';\nimport type { Dev } from 'dev-pkg';\nimport type { Optional } from 'optional-pkg';\nimport type { Peer } from 'peer-pkg';\nexport type T = [Dep, Dev, Optional, Peer];\n",
      }),
      ...createNodeModulePackage(
        'dep-pkg',
        'export interface Dep { value: string }\n',
      ),
      ...createNodeModulePackage(
        'dev-pkg',
        'export interface Dev { value: string }\n',
      ),
      ...createNodeModulePackage(
        'optional-pkg',
        'export interface Optional { value: string }\n',
      ),
      ...createNodeModulePackage(
        'peer-pkg',
        'export interface Peer { value: string }\n',
      ),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses the nearest named package.json for artifact imports', async () => {
    const fixture = await createFixture({
      ...createPackageFixture({
        manifest: {
          dependencies: {
            'nested-pkg': '^1.0.0',
          },
        },
        source:
          "import type { Nested } from 'nested-pkg';\nexport type T = Nested;\n",
      }),
      'app/node_modules/nested-pkg/dist/esm/index.d.ts':
        'export interface Nested { value: string }\n',
      'app/node_modules/nested-pkg/dist/esm/package.json': stringifyConfig({
        type: 'module',
      }),
      'app/node_modules/nested-pkg/package.json': stringifyConfig({
        name: 'nested-pkg',
        type: 'module',
        types: './dist/esm/index.d.ts',
      }),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('falls back to raw package roots for unresolved bare imports', async () => {
    const fixture = await createFixture(
      createPackageFixture({
        manifest: {
          dependencies: {
            zod: '^1.0.0',
          },
        },
        source: "import { z } from 'zod';\nexport const schema = z.string;\n",
      }),
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects typecheck configs that escape nearest package owner', async () => {
    const fixture = await createFixture({
      ...createPackageFixture({
        source: "export const rootValue = 'root';\n",
      }),
      'app/tsconfig.lib.dts.json': buildConfig({
        include: ['src/index.ts'],
      }),
      'app/tsconfig.lib.json': typecheckConfig(['src/index.ts']),
      'app/src/nested/package.json': stringifyConfig({
        name: '@example/nested',
        type: 'module',
      }),
      'app/src/nested/tsconfig.json': typecheckConfig(['../index.ts']),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows bundler virtual module imports', async () => {
    const fixture = await createFixture(
      createPackageFixture({
        source: "import 'virtual:group-icons.css';\nexport const ok = true;\n",
      }),
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows unresolved bare imports declared in peer or optional sections', async () => {
    const fixture = await createFixture(
      createPackageFixture({
        manifest: {
          optionalDependencies: {
            lodash: '^1.0.0',
          },
          peerDependencies: {
            zod: '^1.0.0',
          },
        },
        source:
          "import { z } from 'zod';\nimport chunk from 'lodash/chunk';\nexport const value = [z, chunk];\n",
      }),
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses the nearest nested package owner for dependency authorization', async () => {
    const fixture = await createFixture({
      ...createPackageFixture({
        manifest: {
          dependencies: {
            zod: '^1.0.0',
          },
        },
        source: "export const rootValue = 'root';\n",
      }),
      'app/src/nested/package.json': stringifyConfig({
        name: '@example/nested',
        type: 'module',
      }),
      'app/src/nested/value.ts':
        "import { z } from 'zod';\nexport const nestedValue = z.string();\n",
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects declaration leaves whose file set mixes package owners', async () => {
    const fixture = await createFixture({
      ...createPackageFixture({
        source: "export const rootValue = 'root';\n",
      }),
      'app/src/nested/package.json': stringifyConfig({
        name: '@example/nested',
        type: 'module',
      }),
      'app/src/nested/value.ts': "export const nestedValue = 'nested';\n",
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects relative imports that escape the nearest package owner scope', async () => {
    const fixture = await createFixture({
      ...createPackageFixture({
        source: "export const rootValue = 'root';\n",
      }),
      'app/src/nested/package.json': stringifyConfig({
        name: '@example/nested',
        type: 'module',
      }),
      'app/src/nested/value.ts':
        "import { rootValue } from '../index';\nexport const nestedValue = rootValue;\n",
      'app/src/nested/tsconfig.lib.dts.json': buildConfig({
        include: ['*.ts'],
      }),
      'app/src/nested/tsconfig.lib.json': typecheckConfig(['*.ts']),
      'tsconfig.build.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './app/src/nested/tsconfig.lib.dts.json',
          },
        ],
      }),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('requires workspace packages to be declared by the nearest owner', async () => {
    const fixture = await createFixture({
      ...createPackageFixture({
        source:
          "import { internalValue } from '@example/internal';\nexport const value = internalValue;\n",
      }),
      'packages/internal/package.json': stringifyConfig({
        name: '@example/internal',
        type: 'module',
      }),
      'packages/internal/src/index.ts': 'export const internalValue = 1;\n',
      'packages/internal/tsconfig.lib.dts.json': buildConfig({
        include: ['src/**/*.ts'],
      }),
      'packages/internal/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
      'pnpm-workspace.yaml': `
packages:
  - app
  - packages/*
`,
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows resolved workspace bare imports declared in any dependency section outside strict mode', async () => {
    const pathOptions = {
      baseUrl: '.',
      paths: {
        '@example/internal': ['../packages/internal/src/index.ts'],
      },
    };
    const fixture = await createFixture({
      ...createPackageFixture({
        manifest: {
          peerDependencies: {
            '@example/internal': '^1.0.0',
          },
        },
        source:
          "import { internalValue } from '@example/internal';\nexport const value = internalValue;\n",
      }),
      'app/tsconfig.lib.dts.json': buildConfig({
        compilerOptions: pathOptions,
        include: ['src/**/*.ts'],
      }),
      'app/tsconfig.lib.json': typecheckConfig(['src/**/*.ts'], pathOptions),
      'packages/internal/package.json': stringifyConfig({
        name: '@example/internal',
        type: 'module',
      }),
      'packages/internal/src/index.ts': 'export const internalValue = 1;\n',
      'pnpm-workspace.yaml': `
packages:
  - app
  - packages/*
`,
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects resolved workspace bare imports without workspace: in strict mode', async () => {
    const pathOptions = {
      baseUrl: '.',
      paths: {
        '@example/internal': ['../packages/internal/src/index.ts'],
      },
    };
    const fixture = await createFixture({
      ...createPackageFixture({
        manifest: {
          dependencies: {
            '@example/internal': '^1.0.0',
          },
        },
        source:
          "import { internalValue } from '@example/internal';\nexport const value = internalValue;\n",
      }),
      'app/tsconfig.lib.dts.json': buildConfig({
        compilerOptions: pathOptions,
        include: ['src/**/*.ts'],
      }),
      'app/tsconfig.lib.json': typecheckConfig(['src/**/*.ts'], pathOptions),
      'packages/internal/package.json': stringifyConfig({
        name: '@example/internal',
        type: 'module',
      }),
      'packages/internal/src/index.ts': 'export const internalValue = 1;\n',
      'pnpm-workspace.yaml': `
packages:
  - app
  - packages/*
`,
    });

    try {
      await expect(
        runSourceCheck({
          ...fixture.config,
          strict: true,
        }),
      ).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows bare imports intercepted by tsconfig paths inside the current owner', async () => {
    const pathOptions = {
      baseUrl: '.',
      paths: {
        '@example/local': ['./src/local.ts'],
      },
    };
    const fixture = await createFixture({
      ...createPackageFixture({
        source:
          "import { localValue } from '@example/local';\nexport const value = localValue;\n",
      }),
      'app/src/local.ts': 'export const localValue = 1;\n',
      'app/tsconfig.lib.dts.json': buildConfig({
        compilerOptions: pathOptions,
        include: ['src/**/*.ts'],
      }),
      'app/tsconfig.lib.json': typecheckConfig(['src/**/*.ts'], pathOptions),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows self imports from the nearest owner package name', async () => {
    const fixture = await createFixture(
      createPackageFixture({
        source:
          "import type { Thing } from '@example/app';\nexport interface Thing { value: string }\n",
      }),
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('requires # package imports to be declared in owner package imports', async () => {
    const fixture = await createFixture(
      createPackageFixture({
        source:
          "import { internalValue } from '#internal/value';\nexport const value = internalValue;\n",
      }),
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects # package imports that resolve to another workspace package', async () => {
    const errorSpy = vi
      .spyOn(SourceLogger, 'error')
      .mockImplementation(() => {});
    const pathOptions = {
      baseUrl: '.',
      paths: {
        '#internal': ['../packages/internal/src/index.ts'],
      },
    };
    const fixture = await createFixture({
      ...createPackageFixture({
        manifest: {
          dependencies: {
            '@example/internal': 'workspace:*',
          },
          imports: {
            '#internal': './src/declared-but-not-used.ts',
          },
        },
        source:
          "import { internalValue } from '#internal';\nexport const value = internalValue;\n",
      }),
      'app/tsconfig.lib.dts.json': buildConfig({
        compilerOptions: pathOptions,
        include: ['src/**/*.ts'],
      }),
      'app/tsconfig.lib.json': typecheckConfig(['src/**/*.ts'], pathOptions),
      'packages/internal/package.json': stringifyConfig({
        name: '@example/internal',
        type: 'module',
      }),
      'packages/internal/src/index.ts': 'export const internalValue = 1;\n',
      'pnpm-workspace.yaml': `
packages:
  - app
  - packages/*
`,
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
      expect(errorSpy.mock.calls.join('\n')).toContain(
        'Package import resolves to another package owner:',
      );
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('requires # package imports that resolve to artifact packages to be declared', async () => {
    const pathOptions = {
      baseUrl: '.',
      paths: {
        '#left-pad': ['./node_modules/left-pad/index.d.ts'],
      },
    };
    const fixture = await createFixture({
      ...createPackageFixture({
        manifest: {
          imports: {
            '#left-pad': './src/declared-but-not-used.ts',
          },
        },
        source:
          "import type { LeftPad } from '#left-pad';\nexport type T = LeftPad;\n",
      }),
      'app/tsconfig.lib.dts.json': buildConfig({
        compilerOptions: pathOptions,
        include: ['src/**/*.ts'],
      }),
      'app/tsconfig.lib.json': typecheckConfig(['src/**/*.ts'], pathOptions),
      ...createNodeModulePackage(
        'left-pad',
        'export interface LeftPad { value: string }\n',
      ),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows # package imports that match owner package imports', async () => {
    const fixture = await createFixture(
      createPackageFixture({
        manifest: {
          imports: {
            '#internal/*': './src/internal/*.ts',
          },
        },
        source:
          "import { internalValue } from '#internal/value';\nexport const value = internalValue;\n",
      }),
    );

    try {
      await writeText(
        path.join(fixture.rootDir, 'app/src/internal/value.ts'),
        'export const internalValue = 1;\n',
      );

      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores shared artifact check configs without a file set', async () => {
    const fixture = await createFixture({
      ...createPackageFixture({
        source: "export const value = 'ok';\n",
      }),
      'tsconfig.check.json': stringifyConfig({
        compilerOptions: {
          noEmit: true,
          strict: true,
        },
      }),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not count artifact check configs as source governance units', async () => {
    const fixture = await createFixture({
      ...createPackageFixture({
        source: "export const value = 'checked';\n",
      }),
      'app/tsconfig.check.json': typecheckConfig(['src/index.ts']),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not count declaration leaf configs as source governance units', async () => {
    const fixture = await createFixture({
      ...createPackageFixture({
        source: "export const value = 'checked';\n",
      }),
      'app/tsconfig.extra.dts.json': buildConfig({
        include: ['src/index.ts'],
        tsBuildInfoFile: './.tsbuild/extra.tsbuildinfo',
      }),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects modules governed by multiple tsconfig units', async () => {
    const fixture = await createFixture({
      ...createPackageFixture({
        source: "export const sharedValue = 'shared';\n",
      }),
      'app/tsconfig.test.dts.json': buildConfig({
        include: ['src/index.ts'],
        tsBuildInfoFile: './.tsbuild/test.tsbuildinfo',
      }),
      'app/tsconfig.test.json': typecheckConfig(['src/index.ts']),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects package workspace dependencies that source does not import', async () => {
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appSource: 'export const value = 1;\n',
      }),
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects root workspace dependencies that root-owned source does not import', async () => {
    const fixture = await createFixture(
      createRootWorkspaceDependencyFiles({
        rootSource: 'export const value = 1;\n',
      }),
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts workspace dependencies used by static source imports', async () => {
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appSource:
          "import type { InternalValue } from '@example/internal';\nexport { internalValue } from '@example/internal';\nvoid import('@example/internal');\nexport type Value = InternalValue;\n",
      }),
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('counts workspace dependency subpath imports as root package usage', async () => {
    const fixture = await createFixture(
      createRootWorkspaceDependencyFiles({
        rootSource:
          "import type { InternalValue } from '@example/internal/subpath';\nexport type Value = InternalValue;\n",
      }),
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows configured unused dependencies with a reason', async () => {
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appSource: 'export const value = 1;\n',
      }),
      {
        source: {
          unusedDependencies: {
            ignore: [
              {
                dependency: '@example/internal',
                importer: '@example/app',
                reason: 'Loaded by a generated virtual module in tests.',
              },
            ],
          },
        },
      },
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects invalid unused dependency ignore entries', async () => {
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appSource: 'export const value = 1;\n',
      }),
      {
        source: {
          unusedDependencies: {
            ignore: [
              {
                dependency: '@example/internal',
                importer: '@example/missing',
                reason: 'This package does not exist.',
              },
            ],
          },
        },
      },
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects invalid unused dependency config even without workspace declarations', async () => {
    const fixture = await createFixture(
      createPackageFixture({
        source: 'export const value = 1;\n',
      }),
      {
        source: {
          unusedDependencies:
            [] as unknown as SourceBoundaryConfig['unusedDependencies'],
        },
      },
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('counts workspace dependency usage from the global source boundary', async () => {
    const fixture = await createFixture({
      ...createRootWorkspaceDependencyFiles({
        rootSource: 'export const value = 1;\n',
      }),
      'tools/uses-internal.ts':
        "import { internalValue } from '@example/internal';\nexport const value = internalValue;\n",
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('respects global source excludes when collecting workspace dependency usage', async () => {
    const fixture = await createFixture(
      {
        ...createRootWorkspaceDependencyFiles({
          rootSource: 'export const value = 1;\n',
        }),
        'checks/check-only.ts':
          "import { internalValue } from '@example/internal';\nexport const value = internalValue;\n",
        'tsconfig.check.json': typecheckConfig(['checks/check-only.ts']),
      },
      {
        source: {
          exclude: ['checks'],
        },
      },
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('counts globally included check files when they stay inside source', async () => {
    const fixture = await createFixture({
      ...createRootWorkspaceDependencyFiles({
        rootSource: 'export const value = 1;\n',
      }),
      'checks/check-only.ts':
        "import { internalValue } from '@example/internal';\nexport const value = internalValue;\n",
      'tsconfig.check.json': typecheckConfig(['checks/check-only.ts']),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects usage tsconfigs that include files from another package owner', async () => {
    const fixture = await createFixture(
      createRootWorkspaceDependencyFiles({
        rootSource: 'export const value = 1;\n',
        rootTsconfigInclude: [
          'scripts/**/*.ts',
          'packages/internal/src/**/*.ts',
        ],
      }),
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores external and self dependencies for unused dependency checks', async () => {
    const fixture = await createFixture({
      ...createWorkspacePackageFiles({
        appManifest: {
          dependencies: {
            '@example/app': 'workspace:*',
            zod: '^1.0.0',
          },
        },
        appSource: 'export const value = 1;\n',
      }),
      'packages/app/package.json': stringifyConfig({
        dependencies: {
          '@example/app': 'workspace:*',
          zod: '^1.0.0',
        },
        name: '@example/app',
        type: 'module',
      }),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('leaves label-based dependency deny rules to graph check', async () => {
    const fixture = await createFixture(
      createPackageFixture({
        graph: {
          limina: 'runtime-client',
        },
        source:
          "import { readFileSync } from 'node:fs';\nexport const value = readFileSync;\n",
      }),
      {
        rules: {
          'runtime-client': {
            deny: {
              deps: [
                {
                  name: 'node:*',
                  reason: 'client code must not import Node builtins',
                },
              ],
            },
          },
        },
      },
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not validate graph-only ref or dependency deny entries', async () => {
    const fixture = await createFixture(
      createPackageFixture({
        graph: {
          limina: 'runtime-client',
        },
        source: 'export const value = 1;\n',
      }),
      {
        rules: {
          'runtime-client': {
            deny: {
              refs: [
                {
                  path: 'app/tsconfig.missing.dts.json',
                  reason: 'graph check owns ref deny rules',
                },
              ],
              deps: [
                {
                  name: '@example/missing',
                  reason: 'graph check owns dependency deny rules',
                },
              ],
            },
          },
        },
      },
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });
});
