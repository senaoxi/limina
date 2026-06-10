import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runSourceCheck } from '../commands/source';
import type {
  GraphConfig,
  ResolvedLiminaConfig,
  SourceBoundaryConfig,
  SourceCheckConfig,
  SourceKnipWorkspaceConfig,
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
    | {
        graph?: GraphConfig;
        source?: SourceCheckConfig;
        sourceBoundary?: SourceBoundaryConfig;
      } = {},
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
    Object.hasOwn(options, 'graph') ||
    Object.hasOwn(options, 'source') ||
    Object.hasOwn(options, 'sourceBoundary');
  const graph = hasOptionsShape
    ? (options as { graph?: GraphConfig }).graph
    : (options as GraphConfig);
  const source = hasOptionsShape
    ? (options as { source?: SourceCheckConfig }).source
    : undefined;
  const sourceBoundary = hasOptionsShape
    ? (options as { sourceBoundary?: SourceBoundaryConfig }).sourceBoundary
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
        source: sourceBoundary,
      },
      configPath: path.join(rootDir, 'limina.config.mjs'),
      graph,
      rootDir,
      source,
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
      exports: {
        '.': './src/index.ts',
      },
      name: '@example/app',
      type: 'module',
      ...options.manifest,
    }),
    'app/src/index.ts': options.source,
    'app/tsconfig.json': stringifyConfig({
      files: [],
      references: [
        {
          path: './tsconfig.lib.json',
        },
      ],
    }),
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

function createWorkspaceRootFiles(
  workspaces: string[] = ['packages/*'],
): Record<string, string> {
  return {
    'package.json': stringifyConfig({
      name: '@example/root',
      private: true,
      type: 'module',
      workspaces,
    }),
  };
}

function createWorkspacePackageFiles(options: {
  appManifest?: Record<string, unknown>;
  appSource: string;
  internalManifest?: Record<string, unknown>;
}): Record<string, string> {
  const internalPackageManifest = {
    exports: {
      '.': './src/index.ts',
    },
    name: '@example/internal',
    type: 'module',
    ...options.internalManifest,
  };

  return {
    ...createWorkspaceRootFiles(),
    'node_modules/@example/internal/bin/internal.js': '#!/usr/bin/env node\n',
    'node_modules/@example/internal/package.json': stringifyConfig(
      internalPackageManifest,
    ),
    'packages/app/package.json': stringifyConfig({
      dependencies: {
        '@example/internal': 'workspace:*',
      },
      exports: {
        '.': './src/index.ts',
      },
      name: '@example/app',
      type: 'module',
      ...options.appManifest,
    }),
    'packages/app/src/index.ts': options.appSource,
    'packages/app/tsconfig.json': stringifyConfig({
      files: [],
      references: [
        {
          path: './tsconfig.lib.json',
        },
      ],
    }),
    'packages/app/tsconfig.lib.dts.json': buildConfig({
      include: ['src/**/*.ts'],
      tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
    }),
    'packages/app/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
    'packages/internal/package.json': stringifyConfig(internalPackageManifest),
    'packages/internal/src/index.ts':
      'export type InternalValue = number;\nexport const internalValue = 1;\n',
    'packages/internal/tsconfig.json': stringifyConfig({
      files: [],
      references: [
        {
          path: './tsconfig.lib.json',
        },
      ],
    }),
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
      exports: {
        '.': './scripts/index.ts',
      },
      name: '@example/root',
      private: true,
      type: 'module',
      workspaces: ['packages/*'],
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
    'packages/internal/tsconfig.json': stringifyConfig({
      files: [],
      references: [
        {
          path: './tsconfig.lib.json',
        },
      ],
    }),
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

  it('reports comment imports with kind in package authority diagnostics', async () => {
    const errorSpy = vi
      .spyOn(SourceLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createPackageFixture({
        source:
          '/** @type {import("zod").ZodType} */\nexport const schema = 1;\n',
      }),
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
      const errors = errorSpy.mock.calls.join('\n');

      expect(errors).toContain('Unauthorized bare package import:');
      expect(errors).toContain('file: app/src/index.ts:1 (kind: comment)');
      expect(errors).toContain('imported specifier: zod');
    } finally {
      errorSpy.mockRestore();
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

  it('unwraps unnamed nested artifact package.json files to the named package root', async () => {
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

  it('rejects resolved artifact package roots without package names', async () => {
    const errorSpy = vi
      .spyOn(SourceLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture({
      ...createPackageFixture({
        manifest: {
          dependencies: {
            'unnamed-pkg': '^1.0.0',
          },
        },
        source:
          "import type { Unnamed } from 'unnamed-pkg';\nexport type T = Unnamed;\n",
      }),
      'app/node_modules/unnamed-pkg/index.d.ts':
        'export interface Unnamed { value: string }\n',
      'app/node_modules/unnamed-pkg/package.json': stringifyConfig({
        type: 'module',
        types: './index.d.ts',
      }),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
      const errors = errorSpy.mock.calls.join('\n');

      expect(errors).toContain('Resolved package import has no package name:');
      expect(errors).toContain(
        'resolved package.json: app/node_modules/unnamed-pkg/package.json',
      );
    } finally {
      errorSpy.mockRestore();
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

  it('rejects relative imports that cross workspace package owners', async () => {
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appSource:
          "import { internalValue } from '../../internal/src/index';\nexport const value = internalValue;\n",
      }),
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('requires workspace packages to be declared by the nearest owner', async () => {
    const fixture = await createFixture({
      ...createWorkspaceRootFiles(['app', 'packages/*']),
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
      ...createWorkspaceRootFiles(['app', 'packages/*']),
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
      ...createWorkspaceRootFiles(['app', 'packages/*']),
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
      ...createWorkspaceRootFiles(['app', 'packages/*']),
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

  it('allows nearest bare tsconfig files to own modules directly', async () => {
    const fixture = await createFixture({
      'app/package.json': stringifyConfig({
        exports: {
          '.': './src/index.ts',
        },
        name: '@example/app',
        type: 'module',
      }),
      'app/src/index.ts': "export const value = 'checked';\n",
      'app/tsconfig.json': typecheckConfig(['src/**/*.ts']),
      'app/tsconfig.lib.dts.json': buildConfig({
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
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows nearest bare tsconfig files to resolve transitive typecheck owners', async () => {
    const fixture = await createFixture({
      ...createPackageFixture({
        source: "export const value = 'checked';\n",
      }),
      'app/tsconfig.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './tsconfig.solution.json',
          },
        ],
      }),
      'app/tsconfig.solution.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects modules whose nearest bare tsconfig reaches no owner', async () => {
    const errorSpy = vi
      .spyOn(SourceLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture({
      ...createPackageFixture({
        source: "export const value = 'checked';\n",
      }),
      'app/tsconfig.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './tsconfig.tools.json',
          },
        ],
      }),
      'app/tsconfig.tools.json': typecheckConfig(['tools/**/*.ts']),
      'app/tools/build.ts': "export const tool = 'checked';\n",
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
      const errors = errorSpy.mock.calls.join('\n');

      expect(errors).toContain(
        'Nearest tsconfig cannot determine module owner:',
      );
      expect(errors).toContain('nearest tsconfig: app/tsconfig.json');
      expect(errors).toContain('matched owner tsconfigs:');
      expect(errors).toContain('    (none)');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('rejects modules whose nearest bare tsconfig reaches multiple owners', async () => {
    const errorSpy = vi
      .spyOn(SourceLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture({
      ...createPackageFixture({
        source: "export const value = 'checked';\n",
      }),
      'app/tsconfig.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
          {
            path: './tsconfig.test.json',
          },
        ],
      }),
      'app/tsconfig.test.json': typecheckConfig(['src/index.ts']),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
      const errors = errorSpy.mock.calls.join('\n');

      expect(errors).toContain(
        'nearest tsconfig.json reaches multiple ordinary typecheck configs that include the module',
      );
      expect(errors).toContain('    - app/tsconfig.lib.json');
      expect(errors).toContain('    - app/tsconfig.test.json');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('does not traverse reserved tsconfig references for nearest owner resolution', async () => {
    const errorSpy = vi
      .spyOn(SourceLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture({
      ...createPackageFixture({
        source: "export const value = 'checked';\n",
      }),
      'app/tsconfig.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './tsconfig.build.json',
          },
        ],
      }),
      'app/tsconfig.build.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
      const errors = errorSpy.mock.calls.join('\n');

      expect(errors).toContain(
        'Nearest tsconfig cannot determine module owner:',
      );
      expect(errors).toContain('    (none)');
      expect(errors).not.toContain('    - app/tsconfig.lib.json');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('allows scoped tsconfig ownership ignore globs', async () => {
    const fixture = await createFixture(
      {
        'app/package.json': stringifyConfig({
          name: '@example/app',
          type: 'module',
        }),
        'app/src/index.spec.ts': "export const tested = 'checked';\n",
        'app/tsconfig.json': stringifyConfig({
          files: [],
          references: [],
        }),
        'app/tsconfig.lib.dts.json': buildConfig({
          include: ['src/**/*.spec.ts'],
        }),
        'app/tsconfig.lib.json': typecheckConfig(['src/**/*.spec.ts']),
        'tsconfig.build.json': stringifyConfig({
          files: [],
          references: [
            {
              path: './app/tsconfig.lib.dts.json',
            },
          ],
        }),
      },
      {
        source: {
          tsconfigOwnership: {
            ignore: [
              {
                files: ['app/src/**/*.spec.ts'],
                owner: '@example/app',
                reason: 'Vitest loads test modules directly.',
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

  it('rejects invalid tsconfig ownership ignore entries', async () => {
    const errorSpy = vi
      .spyOn(SourceLogger, 'error')
      .mockImplementation(() => {});
    const ignore = [
      {
        files: ['app/src/**/*.spec.ts'],
        owner: '@example/app',
      },
      {
        files: ['app/src/**/*.spec.ts'],
        owner: '@example/missing',
        reason: 'Missing owner.',
      },
      {
        files: [],
        owner: '@example/app',
        reason: 'Empty files.',
      },
      {
        files: ['packages/internal/src/**/*.spec.ts'],
        owner: '@example/app',
        reason: 'Wrong owner directory.',
      },
    ] as unknown as NonNullable<
      NonNullable<SourceCheckConfig['tsconfigOwnership']>['ignore']
    >;
    const fixture = await createFixture(
      createPackageFixture({
        source: "export const value = 'checked';\n",
      }),
      {
        source: {
          tsconfigOwnership: {
            ignore,
          },
        },
      },
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
      const errors = errorSpy.mock.calls.join('\n');

      expect(errors).toContain('reason must be a non-empty string');
      expect(errors).toContain(
        'owner must name an existing package owner with a package.json name',
      );
      expect(errors).toContain(
        'files must be a non-empty array of workspace-root-relative glob patterns',
      );
      expect(errors).toContain(
        'file patterns must stay inside the owner package directory',
      );
    } finally {
      errorSpy.mockRestore();
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

  it('counts workspace dependencies used by package scripts through a default scoped package bin', async () => {
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appManifest: {
          scripts: {
            typecheck: 'NODE_ENV=test internal check',
          },
        },
        appSource: 'export const value = 1;\n',
        internalManifest: {
          bin: './bin/internal.js',
        },
      }),
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('counts workspace dependencies used by package scripts through object bins', async () => {
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appManifest: {
          scripts: {
            typecheck: 'example-internal check',
          },
        },
        appSource: 'export const value = 1;\n',
        internalManifest: {
          bin: {
            'example-internal': './bin/internal.js',
          },
        },
      }),
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not count package manager script names as workspace binary usage', async () => {
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appManifest: {
          scripts: {
            'example-internal': 'echo local script',
            typecheck: 'pnpm example-internal',
          },
        },
        appSource: 'export const value = 1;\n',
        internalManifest: {
          bin: {
            'example-internal': './bin/internal.js',
          },
        },
      }),
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
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
          knip: {
            workspaces: {
              '@example/app': {
                ignoreDependencies: [
                  {
                    dep: '@example/internal',
                    reason: 'Loaded by a generated virtual module in tests.',
                  },
                ],
              },
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

  it('does not merge raw source.knip dependency ignore arrays', async () => {
    const errorSpy = vi
      .spyOn(SourceLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appSource: 'export const value = 1;\n',
      }),
      {
        source: {
          knip: {
            workspaces: {
              '@example/app': {
                ignoreDependencies: ['@example/internal'],
              } as unknown as SourceKnipWorkspaceConfig,
            },
          },
        },
      },
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
      const errors = errorSpy.mock.calls.join('\n');

      expect(errors).toContain(
        'ignoreDependencies entries must be objects with non-empty dep and reason fields',
      );
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('skips Knip-backed unused dependency checks when source.knip is false', async () => {
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appSource: 'export const value = 1;\n',
      }),
      {
        source: {
          knip: false,
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
    const errorSpy = vi
      .spyOn(SourceLogger, 'error')
      .mockImplementation(() => {});
    const ignore = [
      {
        dep: '@example/internal',
      },
      {
        dep: 'zod',
        reason: 'External packages are outside this rule.',
      },
      {
        dep: '@example/app',
        reason: 'The dependency is not declared by this importer.',
      },
    ] as unknown as SourceKnipWorkspaceConfig['ignoreDependencies'];
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appSource: 'export const value = 1;\n',
      }),
      {
        source: {
          knip: {
            workspaces: {
              '@example/app': {
                ignoreDependencies: ignore,
              },
            },
          },
        },
      },
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
      const errors = errorSpy.mock.calls.join('\n');

      expect(errors).toContain('reason must be a non-empty string');
      expect(errors).toContain(
        'dep must name a package from the pnpm workspace',
      );
      expect(errors).toContain(
        'ignoreDependencies entries must match a workspace dependency declared by the keyed importer package manifest',
      );
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('rejects invalid source.knip workspaces config even without workspace declarations', async () => {
    const fixture = await createFixture(
      createPackageFixture({
        source: 'export const value = 1;\n',
      }),
      {
        source: {
          knip: {
            workspaces: [] as unknown as Record<
              string,
              SourceKnipWorkspaceConfig
            >,
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

  it('rejects unknown source.knip workspace package names', async () => {
    const errorSpy = vi
      .spyOn(SourceLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appSource: 'export const value = 1;\n',
      }),
      {
        source: {
          knip: {
            workspaces: {
              '@example/missing': {
                ignoreDependencies: [
                  {
                    dep: '@example/internal',
                    reason: 'Missing importer package.',
                  },
                ],
              },
            },
          },
        },
      },
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
      const errors = errorSpy.mock.calls.join('\n');

      expect(errors).toContain(
        'workspace config keys must name packages discovered in the pnpm workspace',
      );
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('ignores raw source.knip fields instead of passing them through to Knip', async () => {
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appSource: 'export const value = 1;\n',
      }),
      {
        source: {
          knip: {
            workspaces: {
              '@example/app': {
                project: ['packages/app/src/index.ts'],
              } as unknown as SourceKnipWorkspaceConfig,
            },
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

  it('does not count workspace dependency usage from files unreachable from package entries', async () => {
    const fixture = await createFixture({
      ...createWorkspacePackageFiles({
        appSource: 'export const value = 1;\n',
      }),
      'packages/app/src/dead.ts':
        "import { internalValue } from '@example/internal';\nexport const value = internalValue;\n",
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not use Knip implicit index entry guessing', async () => {
    const fixture = await createFixture({
      ...createWorkspacePackageFiles({
        appManifest: {
          exports: {
            '.': './src/public.ts',
          },
        },
        appSource:
          "import { internalValue } from '@example/internal';\nexport const value = internalValue;\n",
      }),
      'packages/app/src/public.ts': 'export const publicValue = 1;\n',
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses the full owner module set as dependency surface when package exports are absent', async () => {
    const fixture = await createFixture({
      ...createWorkspacePackageFiles({
        appManifest: {
          exports: undefined,
        },
        appSource: 'export const value = 1;\n',
      }),
      'packages/app/src/feature.ts':
        "import { internalValue } from '@example/internal';\nexport const value = internalValue;\n",
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('still reports unused dependencies when no owner modules import them without package exports', async () => {
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appManifest: {
          exports: undefined,
        },
        appSource: 'export const value = 1;\n',
      }),
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts strict source modules reachable from exported source entries', async () => {
    const fixture = await createFixture({
      ...createWorkspacePackageFiles({
        appSource:
          "import { helperValue } from './helper';\nexport { internalValue } from '@example/internal';\nexport const value = helperValue;\n",
      }),
      'packages/app/src/helper.ts': 'export const helperValue = 1;\n',
    });

    try {
      await expect(
        runSourceCheck({
          ...fixture.config,
          strict: true,
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts strict source modules reachable from exported build artifacts through tsconfig source maps', async () => {
    const fixture = await createFixture({
      ...createWorkspacePackageFiles({
        appManifest: {
          exports: {
            '.': './dist/src/index.js',
          },
        },
        appSource: "export { internalValue } from '@example/internal';\n",
      }),
      'packages/app/tsconfig.build.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './tsconfig.lib.dts.json',
          },
        ],
      }),
      'packages/app/tsconfig.lib.dts.json': buildConfig({
        compilerOptions: {
          outDir: './dist',
        },
        include: ['src/**/*.ts'],
        tsBuildInfoFile: './dist/.tsbuildinfo',
      }),
    });

    try {
      await expect(
        runSourceCheck({
          ...fixture.config,
          strict: true,
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects strict source modules unreachable from package entries', async () => {
    const errorSpy = vi
      .spyOn(SourceLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture({
      ...createWorkspacePackageFiles({
        appSource: "export { internalValue } from '@example/internal';\n",
      }),
      'packages/app/src/dead.ts': 'export const deadValue = 1;\n',
    });

    try {
      await expect(
        runSourceCheck({
          ...fixture.config,
          strict: true,
        }),
      ).resolves.toBe(false);
      const errors = errorSpy.mock.calls.join('\n');

      expect(errors).toContain('Unused source module:');
      expect(errors).toContain('owner: @example/app');
      expect(errors).toContain('file: packages/app/src/dead.ts');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('does not report strict unused source modules for no-exports owners', async () => {
    const fixture = await createFixture({
      ...createWorkspacePackageFiles({
        appManifest: {
          exports: undefined,
        },
        appSource: 'export const value = 1;\n',
      }),
      'packages/app/src/feature.ts':
        "import { internalValue } from '@example/internal';\nexport const value = internalValue;\n",
    });

    try {
      await expect(
        runSourceCheck({
          ...fixture.config,
          strict: true,
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not report unreachable source modules outside strict mode', async () => {
    const fixture = await createFixture({
      ...createWorkspacePackageFiles({
        appSource: "export { internalValue } from '@example/internal';\n",
      }),
      'packages/app/src/dead.ts': 'export const deadValue = 1;\n',
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts strict source modules reachable from package bins', async () => {
    const fixture = await createFixture({
      ...createWorkspacePackageFiles({
        appManifest: {
          bin: {
            'example-app': './src/cli.ts',
          },
        },
        appSource: "export { internalValue } from '@example/internal';\n",
      }),
      'packages/app/src/cli.ts': 'export const cliValue = 1;\n',
    });

    try {
      await expect(
        runSourceCheck({
          ...fixture.config,
          strict: true,
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts strict source modules reachable from package scripts', async () => {
    const fixture = await createFixture({
      ...createWorkspacePackageFiles({
        appManifest: {
          scripts: {
            check: 'node src/script-entry.ts',
          },
        },
        appSource: "export { internalValue } from '@example/internal';\n",
      }),
      'packages/app/src/script-entry.ts': 'export const scriptValue = 1;\n',
    });

    try {
      await expect(
        runSourceCheck({
          ...fixture.config,
          strict: true,
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts strict source modules reachable from additional entry globs', async () => {
    const fixture = await createFixture(
      {
        ...createWorkspacePackageFiles({
          appSource: "export { internalValue } from '@example/internal';\n",
        }),
        'packages/app/src/test-entry.spec.ts':
          "import { testedValue } from './tested';\nexport const value = testedValue;\n",
        'packages/app/src/tested.ts': 'export const testedValue = 1;\n',
      },
      {
        source: {
          knip: {
            workspaces: {
              '@example/app': {
                entry: [
                  {
                    files: ['packages/app/src/**/*.spec.ts'],
                    reason: 'Vitest loads spec modules directly.',
                  },
                ],
              },
            },
          },
        },
      },
    );

    try {
      await expect(
        runSourceCheck({
          ...fixture.config,
          strict: true,
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows configured strict unused source modules with a reason', async () => {
    const fixture = await createFixture(
      {
        ...createWorkspacePackageFiles({
          appSource: "export { internalValue } from '@example/internal';\n",
        }),
        'packages/app/src/generated/runtime.ts':
          'export const generatedRuntime = 1;\n',
      },
      {
        source: {
          knip: {
            workspaces: {
              '@example/app': {
                ignoreFiles: [
                  {
                    file: 'packages/app/src/generated/runtime.ts',
                    reason:
                      'Loaded by the framework runtime in generated code.',
                  },
                ],
              },
            },
          },
        },
      },
    );

    try {
      await expect(
        runSourceCheck({
          ...fixture.config,
          strict: true,
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects invalid additional source entry configs', async () => {
    const errorSpy = vi
      .spyOn(SourceLogger, 'error')
      .mockImplementation(() => {});
    const entries = [
      {
        files: ['packages/app/src/**/*.spec.ts'],
      },
      {
        files: [] as string[],
        reason: 'Empty files.',
      },
      {
        files: ['../outside.ts'],
        reason: 'Outside the repository.',
      },
      {
        files: ['packages/internal/src/**/*.ts'],
        reason: 'Wrong owner directory.',
      },
    ] as unknown as SourceKnipWorkspaceConfig['entry'];
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appSource: "export { internalValue } from '@example/internal';\n",
      }),
      {
        source: {
          knip: {
            workspaces: {
              '@example/app': {
                entry: entries,
              },
            },
          },
        },
      },
    );

    try {
      await expect(
        runSourceCheck({
          ...fixture.config,
          strict: true,
        }),
      ).resolves.toBe(false);
      const errors = errorSpy.mock.calls.join('\n');

      expect(errors).toContain('Invalid source Knip entry config:');
      expect(errors).toContain('source.knip.workspaces["@example/app"].entry');
      expect(errors).toContain('reason must be a non-empty string');
      expect(errors).toContain(
        'files must be a non-empty array of workspace-root-relative glob patterns',
      );
      expect(errors).toContain(
        'file patterns must be positive workspace-root-relative globs inside the workspace root',
      );
      expect(errors).toContain(
        'file patterns must stay inside the keyed package directory',
      );
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('rejects invalid unused source module ignore entries', async () => {
    const errorSpy = vi
      .spyOn(SourceLogger, 'error')
      .mockImplementation(() => {});
    const ignore = [
      {
        file: 'packages/app/src/dead.ts',
      },
      {
        file: '../outside.ts',
        reason: 'Outside the repository.',
      },
      {
        file: 'packages/internal/src/index.ts',
        reason: 'Wrong package owner.',
      },
    ] as unknown as SourceKnipWorkspaceConfig['ignoreFiles'];
    const fixture = await createFixture(
      {
        ...createWorkspacePackageFiles({
          appSource: "export { internalValue } from '@example/internal';\n",
        }),
        'packages/app/src/dead.ts': 'export const deadValue = 1;\n',
      },
      {
        source: {
          knip: {
            workspaces: {
              '@example/app': {
                ignoreFiles: ignore,
              },
            },
          },
        },
      },
    );

    try {
      await expect(
        runSourceCheck({
          ...fixture.config,
          strict: true,
        }),
      ).resolves.toBe(false);
      const errors = errorSpy.mock.calls.join('\n');

      expect(errors).toContain('reason must be a non-empty string');
      expect(errors).toContain('file must resolve inside the workspace root');
      expect(errors).toContain(
        'file must belong to the keyed package source module set known to Limina',
      );
    } finally {
      errorSpy.mockRestore();
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
            '@example/internal': 'workspace:*',
            zod: '^1.0.0',
          },
        },
        appSource: "export { internalValue } from '@example/internal';\n",
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
