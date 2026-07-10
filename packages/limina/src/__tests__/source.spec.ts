import type {
  GraphConfig,
  RegionsConfig,
  ResolvedLiminaConfig,
  SourceBoundaryConfig,
  SourceCheckConfig,
  SourceKnipWorkspaceConfig,
} from '#config/runner';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { LiminaCheckRunTaskStats } from '../check-reporting/run-recorder';
import { runSourceCheck } from '../commands/source';
import { createTaskProgressReporter } from '../execution/progress';
import { LiminaOptionalToolMissingError } from '../execution/tools';
import { LiminaFlowReporter } from '../flow';
import { SourceLogger } from '../logger';
import type { KnipCliInvocation } from '../source-check/knip';
import {
  formatSourceCheckHumanReport,
  SOURCE_ISSUE_CODES,
  type SourceCheckIssue,
} from '../source-check/report';
import {
  type LiminaCheckIssue,
  readCheckIssueSnapshot,
  readSourceIssueSnapshot,
} from '../source-check/snapshot';

const ANSI_ESCAPE = String.fromCodePoint(0x1b);
const ANSI_PATTERN = new RegExp(
  String.raw`${ANSI_ESCAPE}\[[\d:;<=>?]*[\u0020-\u002F]*[\u0040-\u007E]`,
  'gu',
);

function stripAnsi(value: string): string {
  return value.replaceAll(ANSI_PATTERN, '');
}

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
        regions?: RegionsConfig;
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
  const fixtureFiles = {
    'package.json': stringifyConfig({
      name: 'root',
      private: true,
    }),
    'pnpm-workspace.yaml': 'packages:\n  - app\n  - packages/*\n',
    ...files,
  };

  for (const [relativePath, text] of Object.entries(fixtureFiles)) {
    await writeText(path.join(rootDir, relativePath), text);
  }

  const hasOptionsShape =
    Object.hasOwn(options, 'graph') ||
    Object.hasOwn(options, 'regions') ||
    Object.hasOwn(options, 'source') ||
    Object.hasOwn(options, 'sourceBoundary');
  const graph = hasOptionsShape
    ? (options as { graph?: GraphConfig }).graph
    : (options as GraphConfig);
  const source = hasOptionsShape
    ? (options as { source?: SourceCheckConfig }).source
    : undefined;
  const regions = hasOptionsShape
    ? (options as { regions?: RegionsConfig }).regions
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
            include: ['tsconfig.json', '**/tsconfig.json'],
          },
        },
        source: sourceBoundary,
      },
      configPath: path.join(rootDir, 'limina.config.mjs'),
      graph,
      regions,
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
    liminaOptions: {
      outputs: {},
    },
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
    'app/package.json': stringifyConfig(
      withDefaultBuildScript({
        exports: {
          '.': './src/index.ts',
        },
        name: '@example/app',
        type: 'module',
        ...options.manifest,
      }),
    ),
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

function createAliasedNodeModulePackage(options: {
  declarations: string;
  packageName: string;
  requestedName: string;
}): Record<string, string> {
  const packageDirectory = `app/node_modules/${options.requestedName}`;

  return {
    [`${packageDirectory}/index.d.ts`]: options.declarations,
    [`${packageDirectory}/package.json`]: stringifyConfig({
      name: options.packageName,
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function withDefaultBuildScript(
  manifest: Record<string, unknown>,
  command = 'limina build tsconfig.json',
): Record<string, unknown> {
  const scripts = isPlainRecord(manifest.scripts) ? manifest.scripts : {};

  return {
    ...manifest,
    scripts: {
      build: command,
      ...scripts,
    },
  };
}

function createWorkspacePackageFiles(options: {
  appManifest?: Record<string, unknown>;
  appSource: string;
  internalManifest?: Record<string, unknown>;
}): Record<string, string> {
  const internalPackageManifest = withDefaultBuildScript({
    exports: {
      '.': './src/index.ts',
    },
    name: '@example/internal',
    type: 'module',
    ...options.internalManifest,
  });

  return {
    ...createWorkspaceRootFiles(),
    'node_modules/@example/internal/bin/internal.js': '#!/usr/bin/env node\n',
    'node_modules/@example/internal/package.json': stringifyConfig(
      internalPackageManifest,
    ),
    'packages/app/package.json': stringifyConfig(
      withDefaultBuildScript({
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
    ),
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
    'package.json': stringifyConfig(
      withDefaultBuildScript({
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
    ),
    'packages/internal/package.json': stringifyConfig(
      withDefaultBuildScript({
        exports: {
          '.': './src/index.ts',
        },
        name: '@example/internal',
        type: 'module',
      }),
    ),
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
  it('rejects external bare imports that are not declared by the source owner', async () => {
    const errorSpy = vi
      .spyOn(SourceLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createPackageFixture({
        source: "import { z } from 'zod';\nexport const schema = z.string();\n",
      }),
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
      const errors = errorSpy.mock.calls.join('\n');

      expect(errors).toContain('\u001B[31mUnauthorized bare package import');
      expect(errors).toContain('\u001B[36mpackage:');
      expect(errors).toContain('\u001B[34mrule:');
      expect(errors).toContain('\u001B[36msummary:\u001B[0m');
      expect(errors).toContain('\u001B[33mreason:\u001B[0m');
      expect(errors).toContain('\u001B[32mfix steps:\u001B[0m');
      expect(errors).toContain('\u001B[36mverify:\u001B[0m');
      expect(errors).toContain('\u001B[35mevidence:\u001B[0m');
      expect(errors).toContain('\u001B[36mfiles:\u001B[0m');
      expect(errors).toContain('fix steps:');
      expect(errors).toContain('Declare "zod" in app/package.json');
      expect(errors).toContain('or optionalDependencies.');
      expect(errors).toContain('source.importAuthority.allow');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('ignores comment imports for package authority diagnostics', async () => {
    const fixture = await createFixture(
      createPackageFixture({
        source:
          '/** @type {import("zod").ZodType} */\nexport const schema = 1;\n',
      }),
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects test file bare imports declared only by root devDependencies without a workspace root dependency grant', async () => {
    const fixture = await createFixture(
      {
        ...createPackageFixture({
          source: "export const value = 'checked';\n",
        }),
        'app/src/index.spec.ts':
          "import { z } from 'zod';\nexport const schema = z.string();\n",
        'package.json': stringifyConfig({
          devDependencies: {
            zod: '^1.0.0',
          },
          name: 'root',
          private: true,
        }),
      },
      {
        source: {
          knip: false,
        },
      },
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ] as const)(
    'allows owner-keyed grants to authorize root %s declarations',
    async (section) => {
      const fixture = await createFixture(
        {
          ...createPackageFixture({
            source:
              "import { z } from 'zod';\nexport const schema = z.string();\n",
          }),
          'package.json': stringifyConfig({
            [section]: {
              zod: '^1.0.0',
            },
            name: 'root',
            private: true,
          }),
        },
        {
          source: {
            importAuthority: {
              allow: {
                '@example/app': [
                  {
                    include: ['src/**'],
                    workspaceRootDependencies: ['zod'],
                    reason: 'The workspace root declares shared test fixtures.',
                  },
                ],
              },
            },
            knip: false,
          },
        },
      );

      try {
        await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('matches workspace root dependency grants by package name for subpath imports', async () => {
    const fixture = await createFixture(
      {
        ...createPackageFixture({
          source:
            "import chunk from 'lodash/chunk';\nexport const value = chunk([1], 1);\n",
        }),
        'package.json': stringifyConfig({
          dependencies: {
            lodash: '^1.0.0',
          },
          name: 'root',
          private: true,
        }),
      },
      {
        source: {
          importAuthority: {
            allow: {
              '@example/app': [
                {
                  include: ['src/**'],
                  workspaceRootDependencies: ['lodash'],
                  reason: 'The workspace root declares shared test fixtures.',
                },
              ],
            },
          },
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

  it('rejects owner-keyed grants when the root manifest does not declare the package', async () => {
    const errorSpy = vi
      .spyOn(SourceLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createPackageFixture({
        source: "import { z } from 'zod';\nexport const schema = z.string();\n",
      }),
      {
        source: {
          importAuthority: {
            allow: {
              '@example/app': [
                {
                  include: ['src/**'],
                  workspaceRootDependencies: ['zod'],
                  reason: 'The workspace root declares shared test fixtures.',
                },
              ],
            },
          },
          knip: false,
        },
      },
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
      const errors = stripAnsi(errorSpy.mock.calls.join('\n'));

      expect(errors).toContain('dependency authority manifests:');
      expect(errors).toContain('- app/package.json');
      expect(errors).toContain('- package.json');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('rejects root declarations when no workspace root dependency grant matches', async () => {
    const fixture = await createFixture(
      {
        ...createPackageFixture({
          source:
            "import { z } from 'zod';\nexport const schema = z.string();\n",
        }),
        'package.json': stringifyConfig({
          dependencies: {
            zod: '^1.0.0',
          },
          name: 'root',
          private: true,
        }),
      },
      {
        source: {
          importAuthority: {
            allow: {
              '@example/app': [
                {
                  include: ['src/**'],
                  workspaceRootDependencies: ['react'],
                  reason: 'The workspace root declares shared test fixtures.',
                },
              ],
            },
          },
          knip: false,
        },
      },
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows omitted include to match all governed source modules for the owner', async () => {
    const fixture = await createFixture(
      {
        ...createPackageFixture({
          source:
            "import { z } from 'zod';\nexport const schema = z.string();\n",
        }),
        'package.json': stringifyConfig({
          dependencies: {
            zod: '^1.0.0',
          },
          name: 'root',
          private: true,
        }),
      },
      {
        source: {
          importAuthority: {
            allow: {
              '@example/app': [
                {
                  workspaceRootDependencies: ['zod'],
                  reason: 'The workspace root declares shared test fixtures.',
                },
              ],
            },
          },
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

  it('rejects root declarations when owner-relative include does not match', async () => {
    const fixture = await createFixture(
      {
        ...createPackageFixture({
          source:
            "import { z } from 'zod';\nexport const schema = z.string();\n",
        }),
        'package.json': stringifyConfig({
          dependencies: {
            zod: '^1.0.0',
          },
          name: 'root',
          private: true,
        }),
      },
      {
        source: {
          importAuthority: {
            allow: {
              '@example/app': [
                {
                  include: ['test/**'],
                  workspaceRootDependencies: ['zod'],
                  reason: 'The workspace root declares shared test fixtures.',
                },
              ],
            },
          },
          knip: false,
        },
      },
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not let a grant for one owner affect another owner', async () => {
    const fixture = await createFixture(
      {
        ...createWorkspacePackageFiles({
          appSource:
            "import { z } from 'zod';\nexport const schema = z.string();\n",
        }),
        'package.json': stringifyConfig(
          withDefaultBuildScript({
            dependencies: {
              zod: '^1.0.0',
            },
            name: '@example/root',
            private: true,
            type: 'module',
            workspaces: ['packages/*'],
          }),
        ),
      },
      {
        source: {
          importAuthority: {
            allow: {
              '@example/internal': [
                {
                  workspaceRootDependencies: ['zod'],
                  reason: 'The workspace root declares shared test fixtures.',
                },
              ],
            },
          },
          knip: false,
        },
      },
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports unknown owner keys with a close suggestion', async () => {
    const errorSpy = vi
      .spyOn(SourceLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      {
        ...createPackageFixture({
          source:
            "import { z } from 'zod';\nexport const schema = z.string();\n",
        }),
        'package.json': stringifyConfig({
          dependencies: {
            zod: '^1.0.0',
          },
          name: 'root',
          private: true,
        }),
      },
      {
        source: {
          importAuthority: {
            allow: {
              '@example/ap': [
                {
                  workspaceRootDependencies: ['zod'],
                  reason: 'The workspace root declares shared test fixtures.',
                },
              ],
            },
          },
          knip: false,
        },
      },
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
      const errors = stripAnsi(errorSpy.mock.calls.join('\n'));

      expect(errors).toContain('Invalid source import authority config');
      expect(errors).toContain('owner: @example/ap');
      expect(errors).toContain('did you mean:');
      expect(errors).toContain('- @example/app');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it.each([
    ['@example/*', 'owner glob keys are not supported'],
    ['*', 'global source import authority owner keys are not supported'],
    ['<root>', 'global source import authority owner keys are not supported'],
    [
      '<workspace>',
      'global source import authority owner keys are not supported',
    ],
  ])('rejects unsupported owner key %s', async (ownerKey, reason) => {
    const errorSpy = vi
      .spyOn(SourceLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createPackageFixture({
        source: 'export const value = 1;\n',
      }),
      {
        source: {
          importAuthority: {
            allow: {
              [ownerKey]: [
                {
                  workspaceRootDependencies: ['zod'],
                  reason: 'The workspace root declares shared test fixtures.',
                },
              ],
            },
          },
          knip: false,
        },
      },
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
      const errors = stripAnsi(errorSpy.mock.calls.join('\n'));

      expect(errors).toContain(reason);
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('does not allow runtime bare imports from public packages through root devDependencies', async () => {
    const fixture = await createFixture({
      ...createPackageFixture({
        source: "import { z } from 'zod';\nexport const schema = z.string();\n",
      }),
      'package.json': stringifyConfig({
        devDependencies: {
          zod: '^1.0.0',
        },
        name: 'root',
        private: true,
      }),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects legacy explicit source import authority rules', async () => {
    const fixture = await createFixture(
      {
        ...createPackageFixture({
          source: "export const value = 'checked';\n",
        }),
        'app/src/template/main.ts':
          "import React from 'react';\nexport const value = React.createElement('div');\n",
      },
      {
        source: {
          importAuthority: {
            allow: [
              {
                files: ['app/src/template/**'],
                specifiers: ['react'],
                reason:
                  'Template files declare dependencies in generated apps.',
              },
            ],
          },
          knip: false,
        } as unknown as SourceCheckConfig,
      },
    );

    try {
      await expect(runSourceCheck(fixture.config)).rejects.toThrow(
        'allow must be an object keyed by source owner identity',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects type-only bare imports declared only by root devDependencies without a workspace root dependency grant', async () => {
    const fixture = await createFixture({
      ...createPackageFixture({
        source:
          "import type { ZodType } from 'zod';\nexport type Schema = ZodType;\n",
      }),
      'package.json': stringifyConfig({
        devDependencies: {
          zod: '^1.0.0',
        },
        name: 'root',
        private: true,
      }),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores nested non-workspace package manifests for dependency authorization', async () => {
    const fixture = await createFixture({
      ...createPackageFixture({
        source: "import { z } from 'zod';\nexport const schema = z.string();\n",
      }),
      'app/src/package.json': stringifyConfig({
        dependencies: {
          zod: '^1.0.0',
        },
        name: '@example/nested',
        type: 'module',
      }),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores intermediate workspace package manifests for dependency authorization', async () => {
    const fixture = await createFixture(
      {
        'pnpm-workspace.yaml': `
packages:
  - packages
  - packages/*
`,
        'packages/package.json': stringifyConfig({
          dependencies: {
            zod: '^1.0.0',
          },
          name: '@example/group',
          private: true,
          type: 'module',
        }),
        'packages/app/package.json': stringifyConfig(
          withDefaultBuildScript({
            exports: {
              '.': './src/index.ts',
            },
            name: '@example/app',
            type: 'module',
          }),
        ),
        'packages/app/src/index.ts':
          "import { z } from 'zod';\nexport const schema = z.string();\n",
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
        }),
        'packages/app/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
        'tsconfig.build.json': stringifyConfig({
          files: [],
          references: [
            {
              path: './packages/app/tsconfig.lib.dts.json',
            },
          ],
        }),
      },
      {
        source: {
          knip: false,
        },
      },
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows root workspace dependency grants when no intermediate workspace package declares the package', async () => {
    const fixture = await createFixture(
      {
        'pnpm-workspace.yaml': `
packages:
  - packages
  - packages/*
`,
        'package.json': stringifyConfig({
          dependencies: {
            zod: '^1.0.0',
          },
          name: 'root',
          private: true,
        }),
        'packages/package.json': stringifyConfig({
          name: '@example/group',
          private: true,
          type: 'module',
        }),
        'packages/app/package.json': stringifyConfig(
          withDefaultBuildScript({
            exports: {
              '.': './src/index.ts',
            },
            name: '@example/app',
            type: 'module',
          }),
        ),
        'packages/app/src/index.ts':
          "import { z } from 'zod';\nexport const schema = z.string();\n",
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
        }),
        'packages/app/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
        'tsconfig.build.json': stringifyConfig({
          files: [],
          references: [
            {
              path: './packages/app/tsconfig.lib.dts.json',
            },
          ],
        }),
      },
      {
        source: {
          importAuthority: {
            allow: {
              '@example/app': [
                {
                  include: ['src/**'],
                  workspaceRootDependencies: ['zod'],
                  reason: 'The workspace root declares shared test fixtures.',
                },
              ],
            },
          },
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

  it('rejects root workspace dependency grants when an intermediate workspace package declares the package', async () => {
    const errorSpy = vi
      .spyOn(SourceLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      {
        'pnpm-workspace.yaml': `
packages:
  - packages
  - packages/*
`,
        'package.json': stringifyConfig({
          dependencies: {
            zod: '^1.0.0',
          },
          name: 'root',
          private: true,
        }),
        'packages/package.json': stringifyConfig({
          dependencies: {
            zod: '^1.0.0',
          },
          name: '@example/group',
          private: true,
          type: 'module',
        }),
        'packages/app/package.json': stringifyConfig(
          withDefaultBuildScript({
            exports: {
              '.': './src/index.ts',
            },
            name: '@example/app',
            type: 'module',
          }),
        ),
        'packages/app/src/index.ts':
          "import { z } from 'zod';\nexport const schema = z.string();\n",
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
        }),
        'packages/app/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
        'tsconfig.build.json': stringifyConfig({
          files: [],
          references: [
            {
              path: './packages/app/tsconfig.lib.dts.json',
            },
          ],
        }),
      },
      {
        source: {
          importAuthority: {
            allow: {
              '@example/app': [
                {
                  include: ['src/**'],
                  workspaceRootDependencies: ['zod'],
                  reason: 'The workspace root declares shared test fixtures.',
                },
              ],
            },
          },
          knip: false,
        },
      },
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
      const errors = stripAnsi(errorSpy.mock.calls.join('\n'));

      expect(errors).toContain('workspace package declares "zod"');
      expect(errors).toContain('intermediate dependency declaration:');
      expect(errors).toContain('package.json: packages/package.json');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('authorizes resolved @types packages by the imported package name', async () => {
    const fixture = await createFixture({
      ...createPackageFixture({
        manifest: {
          dependencies: {
            etag: '^1.0.0',
          },
        },
        source:
          "import etag from 'etag';\nexport const value = etag('body');\n",
      }),
      'app/node_modules/@types/etag/index.d.ts':
        'declare function etag(value: string): string;\nexport default etag;\n',
      'app/node_modules/@types/etag/package.json': stringifyConfig({
        name: '@types/etag',
        types: './index.d.ts',
      }),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('authorizes npm alias dependencies by the imported package key', async () => {
    const fixture = await createFixture({
      ...createPackageFixture({
        manifest: {
          dependencies: {
            execa: 'npm:safe-execa@0.3.0',
          },
        },
        source:
          "import type { ExecaResult } from 'execa';\nexport type T = ExecaResult;\n",
      }),
      ...createAliasedNodeModulePackage({
        declarations: 'export interface ExecaResult { stdout: string }\n',
        packageName: 'safe-execa',
        requestedName: 'execa',
      }),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('authorizes catalog alias dependencies by the imported package key', async () => {
    const fixture = await createFixture({
      ...createPackageFixture({
        manifest: {
          dependencies: {
            execa: 'catalog:',
          },
        },
        source:
          "import type { ExecaResult } from 'execa';\nexport type T = ExecaResult;\n",
      }),
      ...createAliasedNodeModulePackage({
        declarations: 'export interface ExecaResult { stdout: string }\n',
        packageName: 'safe-execa',
        requestedName: 'execa',
      }),
      'pnpm-workspace.yaml': `
packages:
  - app
catalog:
  execa: npm:safe-execa@0.3.0
`,
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects alias imports declared only by the resolved package name', async () => {
    const errorSpy = vi
      .spyOn(SourceLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture({
      ...createPackageFixture({
        manifest: {
          dependencies: {
            'safe-execa': '0.3.0',
          },
        },
        source:
          "import type { ExecaResult } from 'execa';\nexport type T = ExecaResult;\n",
      }),
      ...createAliasedNodeModulePackage({
        declarations: 'export interface ExecaResult { stdout: string }\n',
        packageName: 'safe-execa',
        requestedName: 'execa',
      }),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
      const errors = stripAnsi(errorSpy.mock.calls.join('\n'));

      expect(errors).toContain('Unauthorized bare package import');
      expect(errors).toContain('imported specifier: execa');
      expect(errors).toContain('package: execa');
      expect(errors).toContain('resolved dependency specifier: safe-execa');
      expect(errors).toContain('Declare "execa" in app/package.json');
      expect(errors).not.toContain('Declare "safe-execa" in app/package.json');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('matches workspace root grants by the imported alias package key', async () => {
    const fixture = await createFixture(
      {
        ...createPackageFixture({
          source:
            "import type { ExecaResult } from 'execa';\nexport type T = ExecaResult;\n",
        }),
        ...createAliasedNodeModulePackage({
          declarations: 'export interface ExecaResult { stdout: string }\n',
          packageName: 'safe-execa',
          requestedName: 'execa',
        }),
        'package.json': stringifyConfig({
          dependencies: {
            execa: 'npm:safe-execa@0.3.0',
          },
          name: 'root',
          private: true,
        }),
      },
      {
        source: {
          importAuthority: {
            allow: {
              '@example/app': [
                {
                  workspaceRootDependencies: ['execa'],
                  reason:
                    'The workspace root declares shared alias dependencies.',
                },
              ],
            },
          },
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

  it('does not match workspace root grants by the resolved alias package name', async () => {
    const errorSpy = vi
      .spyOn(SourceLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      {
        ...createPackageFixture({
          source:
            "import type { ExecaResult } from 'execa';\nexport type T = ExecaResult;\n",
        }),
        ...createAliasedNodeModulePackage({
          declarations: 'export interface ExecaResult { stdout: string }\n',
          packageName: 'safe-execa',
          requestedName: 'execa',
        }),
        'package.json': stringifyConfig({
          dependencies: {
            'safe-execa': '0.3.0',
          },
          name: 'root',
          private: true,
        }),
      },
      {
        source: {
          importAuthority: {
            allow: {
              '@example/app': [
                {
                  workspaceRootDependencies: ['safe-execa'],
                  reason:
                    'The workspace root declares shared alias dependencies.',
                },
              ],
            },
          },
          knip: false,
        },
      },
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
      const errors = stripAnsi(errorSpy.mock.calls.join('\n'));

      expect(errors).toContain('package: execa');
      expect(errors).toContain('resolved dependency specifier: safe-execa');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('does not authorize resolved @types packages by @types manifest keys alone', async () => {
    const errorSpy = vi
      .spyOn(SourceLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture({
      ...createPackageFixture({
        manifest: {
          dependencies: {
            '@types/etag': '^1.0.0',
          },
        },
        source:
          "import etag from 'etag';\nexport const value = etag('body');\n",
      }),
      'app/node_modules/@types/etag/index.d.ts':
        'declare function etag(value: string): string;\nexport default etag;\n',
      'app/node_modules/@types/etag/package.json': stringifyConfig({
        name: '@types/etag',
        types: './index.d.ts',
      }),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
      const errors = stripAnsi(errorSpy.mock.calls.join('\n'));

      expect(errors).toContain('package: etag');
      expect(errors).toContain('resolved dependency specifier: @types/etag');
      expect(errors).toContain('"@types/etag" only supplies declarations');
      expect(errors).toContain('authorize "etag".');
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

  it('allows nameless workspace package source owners for path-based source checks', async () => {
    const fixture = await createFixture(
      {
        ...createWorkspaceRootFiles(),
        'packages/fixture/package.json': stringifyConfig({
          private: true,
          type: 'module',
        }),
        'packages/fixture/src/index.ts': 'export const value = 1;\n',
        'packages/fixture/tsconfig.json': stringifyConfig({
          files: [],
          references: [
            {
              path: './tsconfig.lib.json',
            },
          ],
        }),
        'packages/fixture/tsconfig.lib.dts.json': buildConfig({
          include: ['src/**/*.ts'],
        }),
        'packages/fixture/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
        'pnpm-workspace.yaml': `
packages:
  - packages/*
`,
        'tsconfig.build.json': stringifyConfig({
          files: [],
          references: [
            {
              path: './packages/fixture/tsconfig.lib.dts.json',
            },
          ],
        }),
      },
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

  it('allows workspace root grants keyed by nameless owner directory', async () => {
    const fixture = await createFixture(
      {
        'package.json': stringifyConfig({
          dependencies: {
            zod: '^1.0.0',
          },
          name: '@example/root',
          private: true,
          type: 'module',
          workspaces: ['packages/*'],
        }),
        'packages/fixture/package.json': stringifyConfig({
          private: true,
          type: 'module',
        }),
        'packages/fixture/src/index.ts':
          "import { z } from 'zod';\nexport const schema = z.string();\n",
        'packages/fixture/tsconfig.json': stringifyConfig({
          files: [],
          references: [
            {
              path: './tsconfig.lib.json',
            },
          ],
        }),
        'packages/fixture/tsconfig.lib.dts.json': buildConfig({
          include: ['src/**/*.ts'],
        }),
        'packages/fixture/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
        'pnpm-workspace.yaml': `
packages:
  - packages/*
`,
        'tsconfig.build.json': stringifyConfig({
          files: [],
          references: [
            {
              path: './packages/fixture/tsconfig.lib.dts.json',
            },
          ],
        }),
      },
      {
        source: {
          importAuthority: {
            allow: {
              'packages/fixture': [
                {
                  include: ['src/**'],
                  workspaceRootDependencies: ['zod'],
                  reason: 'The workspace root declares shared test fixtures.',
                },
              ],
            },
          },
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

      expect(errors).toContain(
        'Resolved package import has no package name  1 issue',
      );
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

  it('stops source governance at nested package scopes by default', async () => {
    const fixture = await createFixture(
      {
        ...createPackageFixture({
          source: "export const rootValue = 'root';\n",
        }),
        'app/src/nested/package.json': stringifyConfig({
          name: '@example/nested',
          type: 'module',
        }),
        'app/src/nested/value.ts': "export const nestedValue = 'nested';\n",
      },
      {
        source: {
          knip: false,
        },
      },
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('extends eligible nameless nested package scopes when configured', async () => {
    const fixture = await createFixture(
      {
        ...createPackageFixture({
          source: "export const rootValue = 'root';\n",
        }),
        'app/src/nested/package.json': stringifyConfig({
          type: 'module',
        }),
        'app/src/nested/value.ts': "export const nestedValue = 'nested';\n",
      },
      {
        regions: {
          extendNestedPackageScopes: true,
        },
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

  it('uses the pnpm workspace source owner for dependency authorization across nested package scopes', async () => {
    const fixture = await createFixture(
      {
        ...createPackageFixture({
          manifest: {
            dependencies: {
              zod: '^1.0.0',
            },
          },
          source: "export const rootValue = 'root';\n",
        }),
        'app/src/nested/package.json': stringifyConfig({
          type: 'module',
        }),
        'app/src/nested/value.ts':
          "import { z } from 'zod';\nexport const nestedValue = z.string();\n",
      },
      {
        regions: {
          extendNestedPackageScopes: true,
        },
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

  it('allows declaration leaves whose file set crosses nested non-workspace package scopes', async () => {
    const fixture = await createFixture(
      {
        ...createPackageFixture({
          source: "export const rootValue = 'root';\n",
        }),
        'app/src/nested/package.json': stringifyConfig({
          type: 'module',
        }),
        'app/src/nested/value.ts': "export const nestedValue = 'nested';\n",
      },
      {
        regions: {
          extendNestedPackageScopes: true,
        },
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

  it('rejects relative imports that cross nested package scopes', async () => {
    const fixture = await createFixture(
      {
        ...createPackageFixture({
          source: "export const rootValue = 'root';\n",
        }),
        'app/src/nested/package.json': stringifyConfig({
          type: 'module',
        }),
        'app/src/nested/value.ts':
          "import { rootValue } from '../index';\nexport const nestedValue = rootValue;\n",
      },
      {
        regions: {
          extendNestedPackageScopes: true,
        },
        source: {
          knip: false,
        },
      },
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects relative imports that cross workspace package scopes', async () => {
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

  it('requires workspace packages to be declared by the source owner', async () => {
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

  it('allows resolved workspace bare imports declared in any dependency section', async () => {
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

  it('allows resolved workspace bare imports with any declared dependency protocol', async () => {
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
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
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

  it('requires # package imports to be declared in the nearest package scope', async () => {
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

  it('allows # package imports declared by the nearest package scope', async () => {
    const fixture = await createFixture(
      {
        ...createPackageFixture({
          source: "export const rootValue = 'root';\n",
        }),
        'app/src/nested/file.ts':
          "import { internalValue } from '#internal';\nexport const nestedValue = internalValue;\n",
        'app/src/nested/internal.ts': 'export const internalValue = 1;\n',
        'app/src/nested/package.json': stringifyConfig({
          imports: {
            '#internal': './internal.ts',
          },
          type: 'module',
        }),
      },
      {
        regions: {
          extendNestedPackageScopes: true,
        },
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

  it('rejects relative # package import targets outside the declaring package scope', async () => {
    const errorSpy = vi
      .spyOn(SourceLogger, 'error')
      .mockImplementation(() => {});
    const pathOptions = {
      baseUrl: '.',
      paths: {
        '#root': ['./src/index.ts'],
      },
    };
    const fixture = await createFixture(
      {
        ...createPackageFixture({
          source: "export const rootValue = 'root';\n",
        }),
        'app/src/nested/file.ts':
          "import { rootValue } from '#root';\nexport const nestedValue = rootValue;\n",
        'app/src/nested/local.ts': 'export const localValue = 1;\n',
        'app/src/nested/package.json': stringifyConfig({
          imports: {
            '#root': './local.ts',
          },
          type: 'module',
        }),
        'app/tsconfig.lib.dts.json': buildConfig({
          compilerOptions: pathOptions,
          include: ['src/**/*.ts'],
        }),
        'app/tsconfig.lib.json': typecheckConfig(['src/**/*.ts'], pathOptions),
      },
      {
        regions: {
          extendNestedPackageScopes: true,
        },
        source: {
          knip: false,
        },
      },
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
      expect(errorSpy.mock.calls.join('\n')).toContain(
        'Package import relative target escapes package scope  1 issue',
      );
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('rejects relative # package imports that resolve to another workspace package', async () => {
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
        'Package import relative target escapes package scope  1 issue',
      );
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('requires # package imports that resolve to artifact packages to be declared', async () => {
    const fixture = await createFixture({
      ...createPackageFixture({
        manifest: {
          imports: {
            '#left-pad': 'left-pad',
          },
        },
        source:
          "import type { LeftPad } from '#left-pad';\nexport type T = LeftPad;\n",
      }),
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

  it('allows # package imports that resolve to declared artifact packages', async () => {
    const fixture = await createFixture({
      ...createPackageFixture({
        manifest: {
          dependencies: {
            'left-pad': '^1.0.0',
          },
          imports: {
            '#left-pad': 'left-pad',
          },
        },
        source:
          "import type { LeftPad } from '#left-pad';\nexport type T = LeftPad;\n",
      }),
      ...createNodeModulePackage(
        'left-pad',
        'export interface LeftPad { value: string }\n',
      ),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows # package imports that resolve to declared workspace packages', async () => {
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
            '#internal': '@example/internal',
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
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows # package imports that match nearest package scope imports', async () => {
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
      ...createWorkspaceRootFiles(['app']),
      'app/package.json': stringifyConfig({
        exports: {
          '.': './src/index.ts',
        },
        name: '@example/app',
        scripts: {
          build: 'limina build tsconfig.json',
        },
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

  it('allows nearest bare tsconfig files to resolve solution typecheck owners', async () => {
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
        ],
      }),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('continues upward when the nearest bare tsconfig does not own the module', async () => {
    const fixture = await createFixture(
      {
        ...createPackageFixture({
          source: "export const value = 'checked';\n",
        }),
        'app/tools/build.ts': "export const tool = 'checked';\n",
        'app/tsconfig.json': stringifyConfig({
          files: [],
          references: [
            {
              path: './tsconfig.lib.json',
            },
          ],
        }),
        'app/tsconfig.tools.json': typecheckConfig(['tools/**/*.ts']),
        'tsconfig.json': stringifyConfig({
          files: [],
          references: [
            {
              path: './app/tsconfig.tools.json',
            },
          ],
        }),
      },
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

  it('rejects modules when upward tsconfig search reaches no owner', async () => {
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
        ],
      }),
      'app/tsconfig.tools.json': typecheckConfig(['tools/**/*.ts']),
      'app/tools/build.ts': "export const tool = 'checked';\n",
      'external/tsconfig.json': stringifyConfig({
        files: [],
        references: [
          {
            path: '../app/tsconfig.tools.json',
          },
        ],
      }),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
      const errors = errorSpy.mock.calls.join('\n');

      expect(errors).toContain(
        'Tsconfig search cannot determine module owner  1 issue',
      );
      expect(errors).toContain('resolver tsconfig: app/tsconfig.json');
      expect(errors).toContain('app/tools/build.ts');

      const sourceSnapshot = await readSourceIssueSnapshot(fixture.rootDir);

      expect(
        sourceSnapshot?.issues.some((issue) =>
          issue.filePath?.endsWith('app/tools/build.ts'),
        ),
      ).toBe(true);

      const checkSnapshot = await readCheckIssueSnapshot(fixture.rootDir);
      const checkIssue = checkSnapshot?.issues.find(
        (issue) =>
          issue.title === 'Tsconfig search cannot determine module owner',
      );

      expect(checkIssue?.evidence).toEqual([
        expect.objectContaining({
          label: 'diagnostic',
          lines: expect.arrayContaining([
            'Tsconfig search cannot determine module owner:',
            '  file: app/tools/build.ts',
            '  resolver tsconfig: app/tsconfig.json',
          ]),
        }),
      ]);
      expect(checkIssue?.detailLines).toBeUndefined();
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
        'Tsconfig search cannot determine module owner  1 issue',
      );
      expect(errors).toContain(
        'Source module belongs to multiple tsconfig governance units  1 issue',
      );
      expect(errors).toContain('app/src/index.ts');
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
      'external/tsconfig.json': stringifyConfig({
        files: [],
        references: [
          {
            path: '../app/tsconfig.lib.json',
          },
        ],
      }),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
      const errors = errorSpy.mock.calls.join('\n');

      expect(errors).toContain(
        'Tsconfig search cannot determine module owner  1 issue',
      );
      expect(errors).toContain('app/src/index.ts');
      expect(errors).not.toContain('    - app/tsconfig.lib.json');
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

  it('skips Knip-backed source usage when knip is not installed', async () => {
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appSource: "export { internalValue } from '@example/internal';\n",
      }),
    );
    const chunks: string[] = [];
    const flow = new LiminaFlowReporter({
      env: {
        CI: 'true',
      },
      output: {
        write: (message) => {
          chunks.push(message);
        },
      },
      stdout: {
        isTTY: false,
      },
    });
    const sourceTask = flow.tree('source check');
    let stats: LiminaCheckRunTaskStats | undefined;

    sourceTask.start();

    try {
      await expect(
        runSourceCheck(fixture.config, {
          knipRunner: async () => {
            throw new LiminaOptionalToolMissingError({
              command: 'source check',
              error: new Error('Cannot find package "knip"'),
              packageName: 'knip',
            });
          },
          onStats: (nextStats) => {
            stats = nextStats;
          },
          progress: createTaskProgressReporter(sourceTask),
          report: {
            defer: true,
          },
        }),
      ).resolves.toBe(true);

      expect(stripAnsi(chunks.join(''))).toContain(
        '[skip] knip is not installed; skipping check',
      );
      expect(
        stats?.items?.find((item) => item.name === 'knip source usage'),
      ).toMatchObject({
        checksPassed: 0,
        checksTotal: 0,
        issues: 0,
        status: 'skipped',
      });
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
      expect(errors).toContain('importer: @example/app');
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

  it('does not allow source.knip workspace config to target a nameless workspace package', async () => {
    const errorSpy = vi
      .spyOn(SourceLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appManifest: {
          name: undefined,
        },
        appSource: 'export const value = 1;\n',
      }),
      {
        source: {
          knip: {
            workspaces: {
              '@example/app': {
                ignoreFiles: [],
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

  it('ignores nameless workspace package manifests as workspace dependency identities in Knip analysis', async () => {
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appManifest: {
          name: undefined,
        },
        appSource: "export { internalValue } from '@example/internal';\n",
      }),
    );

    try {
      await expect(
        runSourceCheck(fixture.config, {
          knipRunner: async () =>
            JSON.stringify({
              issues: [
                {
                  dependencies: [
                    {
                      name: '@example/internal',
                    },
                  ],
                  file: 'packages/app/package.json',
                },
              ],
            }),
        }),
      ).resolves.toBe(true);
    } finally {
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

  it('accepts source modules reachable from exported source entries', async () => {
    const fixture = await createFixture({
      ...createWorkspacePackageFiles({
        appSource:
          "import { helperValue } from './helper';\nexport { internalValue } from '@example/internal';\nexport const value = helperValue;\n",
      }),
      'packages/app/src/helper.ts': 'export const helperValue = 1;\n',
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts source modules reachable from exported build artifacts through package build script source maps', async () => {
    const fixture = await createFixture({
      ...createWorkspacePackageFiles({
        appManifest: {
          exports: {
            '.': './dist/index.js',
          },
          scripts: {
            build: 'limina build tsconfig.dts.json --raw --preset tsc',
          },
        },
        appSource: "export { internalValue } from '@example/internal';\n",
      }),
      'packages/app/tsconfig.dts.json': buildConfig({
        compilerOptions: {
          outDir: './dist',
          rootDir: './src',
        },
        include: ['src/**/*.ts'],
        tsBuildInfoFile: './dist/.tsbuildinfo',
      }),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses generated package Knip tsconfig from static build scripts', async () => {
    const fixture = await createFixture({
      ...createWorkspacePackageFiles({
        appManifest: {
          exports: {
            '.': './dist/index.js',
          },
        },
        appSource: "export { internalValue } from '@example/internal';\n",
      }),
      'packages/app/tsconfig.json': stringifyConfig({
        liminaOptions: {
          outputs: {
            outDir: './dist',
            rootDir: './src',
          },
        },
        compilerOptions: {
          ...buildCompilerOptions,
          noEmit: true,
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('falls back to Knip default tsconfig when package build scripts do not declare a Knip tsconfig source', async () => {
    const invocations: KnipCliInvocation[] = [];
    const fixture = await createFixture({
      'app/package.json': stringifyConfig({
        exports: {
          '.': './src/index.ts',
        },
        name: '@example/app',
        type: 'module',
      }),
      'app/src/index.ts': 'export const value = 1;\n',
      'app/tsconfig.json': typecheckConfig(['src/**/*.ts']),
    });

    try {
      await expect(
        runSourceCheck(fixture.config, {
          knipRunner: async (options) => {
            invocations.push(options);
            return '{"issues":[]}';
          },
        }),
      ).resolves.toBe(true);

      expect(invocations).toHaveLength(1);
      expect(invocations[0]).toMatchObject({
        workspaceNames: ['@example/app'],
      });
      expect(invocations[0]?.tsConfigFile).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects unsupported package build scripts instead of falling back to Knip default tsconfig', async () => {
    const errorSpy = vi
      .spyOn(SourceLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture({
      'app/package.json': stringifyConfig({
        exports: {
          '.': './src/index.ts',
        },
        name: '@example/app',
        scripts: {
          build: 'limina build $CONFIG',
        },
        type: 'module',
      }),
      'app/src/index.ts': 'export const value = 1;\n',
      'app/tsconfig.json': typecheckConfig(['src/**/*.ts']),
    });

    try {
      await expect(
        runSourceCheck(fixture.config, {
          knipRunner: async () => {
            throw new Error('Knip should not run after script diagnostics.');
          },
        }),
      ).resolves.toBe(false);
      const errors = errorSpy.mock.calls.join('\n');

      expect(errors).toContain(
        'Unsupported package build script for generated Knip tsconfig  1 issue',
      );
      expect(errors).toContain('command: limina build $CONFIG');
      expect(errors).toContain('static limina build scripts');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('mixes generated Knip tsconfig groups with default Knip tsconfig fallback groups', async () => {
    const invocations: KnipCliInvocation[] = [];
    const fixture = await createFixture({
      ...createWorkspaceRootFiles(),
      'packages/app/package.json': stringifyConfig({
        exports: {
          '.': './dist/index.js',
        },
        name: '@example/app',
        scripts: {
          build: 'limina build tsconfig.dts.json --raw --preset tsc',
        },
        type: 'module',
      }),
      'packages/app/src/index.ts': 'export const appValue = 1;\n',
      'packages/app/tsconfig.dts.json': buildConfig({
        compilerOptions: {
          outDir: './dist',
          rootDir: './src',
        },
        include: ['src/**/*.ts'],
        tsBuildInfoFile: './dist/.tsbuildinfo',
      }),
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
      'packages/tool/package.json': stringifyConfig({
        exports: {
          '.': './src/index.ts',
        },
        name: '@example/tool',
        type: 'module',
      }),
      'packages/tool/src/index.ts': 'export const toolValue = 1;\n',
      'packages/tool/tsconfig.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
      'packages/tool/tsconfig.lib.dts.json': buildConfig({
        include: ['src/**/*.ts'],
        tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
      }),
      'packages/tool/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
      'packages/cli/package.json': stringifyConfig({
        exports: {
          '.': './src/index.ts',
        },
        name: '@example/cli',
        type: 'module',
      }),
      'packages/cli/src/index.ts': 'export const cliValue = 1;\n',
      'packages/cli/tsconfig.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
      'packages/cli/tsconfig.lib.dts.json': buildConfig({
        include: ['src/**/*.ts'],
        tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
      }),
      'packages/cli/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
    });

    try {
      await expect(
        runSourceCheck(fixture.config, {
          knipRunner: async (options) => {
            invocations.push(options);
            return '{"issues":[]}';
          },
        }),
      ).resolves.toBe(true);

      const generatedInvocation = invocations.find(
        (invocation) => invocation.tsConfigFile,
      );
      const defaultInvocation = invocations.find(
        (invocation) => !invocation.tsConfigFile,
      );

      expect(invocations).toHaveLength(2);
      expect(generatedInvocation?.workspaceNames).toEqual(['@example/app']);
      expect(generatedInvocation?.tsConfigFile).toContain('tsconfig.knip.json');
      expect(defaultInvocation?.tsConfigFile).toBeUndefined();
      expect([...(defaultInvocation?.workspaceNames ?? [])].sort()).toEqual([
        '@example/cli',
        '@example/tool',
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('merges Knip results for workspaces using different generated Knip tsconfigs', async () => {
    const fixture = await createFixture({
      ...createWorkspacePackageFiles({
        appManifest: {
          exports: {
            '.': './dist/index.js',
          },
          scripts: {
            build: 'limina build tsconfig.dts.json --raw --preset tsc',
          },
        },
        appSource: "export { internalValue } from '@example/internal';\n",
      }),
      'packages/app/tsconfig.dts.json': buildConfig({
        compilerOptions: {
          outDir: './dist',
          rootDir: './src',
        },
        include: ['src/**/*.ts'],
        tsBuildInfoFile: './dist/.tsbuildinfo',
      }),
      'packages/tool/package.json': stringifyConfig({
        dependencies: {
          '@example/internal': 'workspace:*',
        },
        exports: {
          '.': './lib/index.js',
        },
        name: '@example/tool',
        scripts: {
          build: 'limina build tsconfig.custom.json --raw --preset tsc',
        },
        type: 'module',
      }),
      'packages/tool/src/index.ts':
        "export { internalValue } from '@example/internal';\n",
      'packages/tool/tsconfig.custom.json': buildConfig({
        compilerOptions: {
          outDir: './lib',
          rootDir: './src',
        },
        include: ['src/**/*.ts'],
        tsBuildInfoFile: './lib/.tsbuildinfo',
      }),
      'packages/tool/tsconfig.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
      'packages/tool/tsconfig.lib.dts.json': buildConfig({
        include: ['src/**/*.ts'],
        tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
      }),
      'packages/tool/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects source modules unreachable from package entries', async () => {
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
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
      const errors = errorSpy.mock.calls.join('\n');

      expect(errors).toContain('Found 1 unused source module in 1 package.');
      expect(errors).toContain(`rule: ${SOURCE_ISSUE_CODES.unusedModule}`);
      expect(errors).toContain('@example/app');
      expect(errors).toContain('packages/app/src/dead.ts');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('renders unused source summaries in a titled aligned box', async () => {
    const fixture = await createFixture({});
    const packageJsonPath = path.join(
      fixture.rootDir,
      'packages/app/package.json',
    );
    const issues = [
      {
        code: SOURCE_ISSUE_CODES.unusedModule,
        filePath: path.join(fixture.rootDir, 'packages/app/src/dead.ts'),
        ownerDirectory: path.join(fixture.rootDir, 'packages/app'),
        ownerName: '@example/app',
        packageJsonPath,
      },
      {
        code: SOURCE_ISSUE_CODES.unusedWorkspaceDependency,
        dependencyName: '@example/internal',
        ownerName: '@example/app',
        packageJsonPath,
        sectionName: 'dependencies',
        specifier: 'workspace:*',
      },
    ] satisfies SourceCheckIssue[];

    try {
      const report = formatSourceCheckHumanReport({
        config: fixture.config,
        issues,
        legacyProblems: [],
        report: {
          command: 'limina check',
        },
      });
      const summaryLines = report
        .split('\n')
        .filter((line) => line.includes('Found '));

      expect(report).toContain('Source check summary');
      expect(report).toMatch(
        /│ Found 1 unused source module in 1 package\.\s+│/u,
      );
      expect(report).toMatch(
        /│ Found 1 unused workspace package dependency in 1 package\.\s+│/u,
      );
      expect(summaryLines.map((line) => line.indexOf('Found'))).toEqual([2, 2]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('groups and truncates legacy source check problems by owner and package', async () => {
    const fixture = await createFixture({});
    const legacyProblems = Array.from({ length: 6 }, (_, index) =>
      [
        'Unauthorized bare package import:',
        '  source owner: docs/package.json',
        `  file: docs/.vitepress/theme/landing/file-${index.toString().padStart(2, '0')}.vue:2 (kind: static)`,
        `  imported specifier: @components/shared/File${index}.vue`,
        '  package: @components/shared',
        '  reason: source imports must be declared by the nearest pnpm workspace source owner or by an explicitly configured workspace root dependency grant.',
        '  fix: Declare "@components/shared" in docs/package.json dependencies, devDependencies, peerDependencies, or optionalDependencies. If this package is intentionally declared by the workspace root, add source.importAuthority.allow["@example/docs"] with workspaceRootDependencies: ["@components/shared"] and a reason.',
      ].join('\n'),
    );

    try {
      const report = formatSourceCheckHumanReport({
        config: fixture.config,
        issues: [],
        legacyProblems: [...legacyProblems, legacyProblems[0]!],
        report: {
          command: 'limina source check',
        },
      });

      expect(report).toContain('Found 6 source check issues.');
      expect(report).toContain('Unauthorized bare package import  6 issues');
      expect(report).toContain('source owner: docs/package.json');
      expect(report).toContain('package: @components/shared');
      expect(report).toContain('suggested fix:');
      expect(report).toContain(
        'Declare "@components/shared" in docs/package.json',
      );
      expect(report).toContain('files:');
      expect(report).toContain(
        'docs/.vitepress/theme/landing/file-00.vue:2 (kind: static)',
      );
      expect(report).toContain(
        'docs/.vitepress/theme/landing/file-04.vue:2 (kind: static)',
      );
      expect(report).not.toContain(
        'docs/.vitepress/theme/landing/file-05.vue:2 (kind: static)',
      );
      expect(report).toContain('... 1 more');
      expect(report).toContain('Show all files:');
      expect(report).toContain('limina source check --verbose');
      expect(
        report.match(/Unauthorized bare package import:/gu) ?? [],
      ).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('writes the last-run source issue snapshot for failed structured issues', async () => {
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
        runSourceCheck(fixture.config, {
          report: {
            command: 'limina check',
          },
        }),
      ).resolves.toBe(false);

      const snapshot = await readSourceIssueSnapshot(fixture.rootDir);

      expect(snapshot).toMatchObject({
        command: 'limina check',
        legacyProblemCount: 0,
        status: 'completed',
      });
      expect(snapshot?.issues).toEqual([
        {
          code: SOURCE_ISSUE_CODES.unusedModule,
          filePath: 'packages/app/src/dead.ts',
          ownerName: '@example/app',
        },
      ]);

      const checkSnapshot = await readCheckIssueSnapshot(fixture.rootDir);

      expect(checkSnapshot?.issues).toContainEqual(
        expect.objectContaining({
          code: SOURCE_ISSUE_CODES.unusedModule,
          filePath: 'packages/app/src/dead.ts',
          packageName: '@example/app',
          reason: expect.any(String),
          scope: 'packages/app/src',
          task: 'source:check',
          title: 'Unused source module',
        }),
      );
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('writes an empty last-run source issue snapshot for passing checks', async () => {
    const fixture = await createFixture({
      ...createWorkspacePackageFiles({
        appSource: "export { internalValue } from '@example/internal';\n",
      }),
    });

    try {
      await expect(
        runSourceCheck(fixture.config, {
          report: {
            command: 'limina source check',
          },
        }),
      ).resolves.toBe(true);

      const snapshot = await readSourceIssueSnapshot(fixture.rootDir);

      expect(snapshot).toMatchObject({
        command: 'limina source check',
        issues: [],
        legacyProblemCount: 0,
        status: 'completed',
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('groups and truncates unused source modules by default', async () => {
    const errorSpy = vi
      .spyOn(SourceLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture({
      ...createWorkspacePackageFiles({
        appSource: "export { internalValue } from '@example/internal';\n",
      }),
      'packages/app/src/dead-a.ts': 'export const deadA = 1;\n',
      'packages/app/src/dead-b.ts': 'export const deadB = 1;\n',
      'packages/app/src/dead-c.ts': 'export const deadC = 1;\n',
      'packages/app/src/dead-d.ts': 'export const deadD = 1;\n',
      'packages/app/src/dead-e.ts': 'export const deadE = 1;\n',
      'packages/app/src/dead-f.ts': 'export const deadF = 1;\n',
    });

    try {
      await expect(
        runSourceCheck(fixture.config, {
          report: {
            command: 'limina check',
          },
        }),
      ).resolves.toBe(false);

      const errors = errorSpy.mock.calls.join('\n');

      expect(errors).toContain('Found 6 unused source modules in 1 package.');
      expect(errors).toContain(`rule: ${SOURCE_ISSUE_CODES.unusedModule}`);
      expect(errors).toContain(
        'source.knip.workspaces["@example/app"].ignoreFiles',
      );
      expect(errors).toContain('... 1 more');
      expect(errors).toContain('Show all files:');
      expect(errors).toContain('limina check --verbose');
      const plainErrors = stripAnsi(errors);

      expect(plainErrors).toMatch(/┌─+┐\n│\s*@example\/app\s+│/u);
      expect(plainErrors).toMatch(
        /│ package manifest: packages\/app\/package\.json\s+│/u,
      );
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('expands unused source module report boxes to fit the longest file path', async () => {
    const errorSpy = vi
      .spyOn(SourceLogger, 'error')
      .mockImplementation(() => {});
    const longUnusedFilePath =
      'packages/app/src/features/really/deeply/nested/module/with/an/excessively/descriptive/generated-unused-component-entry-point.ts';
    const fixture = await createFixture({
      ...createWorkspacePackageFiles({
        appSource: "export { internalValue } from '@example/internal';\n",
      }),
      [longUnusedFilePath]: 'export const deadValue = 1;\n',
    });

    try {
      await expect(
        runSourceCheck(fixture.config, {
          report: {
            command: 'limina check',
          },
        }),
      ).resolves.toBe(false);

      const errors = errorSpy.mock.calls.join('\n');
      const boxedLines = errors
        .split('\n')
        .filter((line) => /^[┌│└]/u.test(line));
      const expectedBoxWidth = longUnusedFilePath.length + '  - '.length + 4;
      const fileLine = boxedLines.find((line) =>
        line.includes(longUnusedFilePath),
      );

      expect(boxedLines.length).toBeGreaterThan(0);
      expect(fileLine).toBe(`│   - ${longUnusedFilePath} │`);
      expect(fileLine?.length).toBe(expectedBoxWidth);
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('renders filtered verbose unused source module details', async () => {
    const errorSpy = vi
      .spyOn(SourceLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture({
      ...createWorkspacePackageFiles({
        appSource: "export { internalValue } from '@example/internal';\n",
      }),
      'packages/app/src/theme/button.ts': 'export const button = 1;\n',
      'packages/app/src/theme/card.ts': 'export const card = 1;\n',
      'packages/app/src/other.ts': 'export const other = 1;\n',
    });

    try {
      await expect(
        runSourceCheck(fixture.config, {
          report: {
            command: 'limina check',
            packageNames: ['@example/app'],
            rules: [SOURCE_ISSUE_CODES.unusedModule],
            scopes: ['packages/app/src/theme'],
            verbose: true,
          },
        }),
      ).resolves.toBe(false);

      const errors = errorSpy.mock.calls.join('\n');

      expect(errors).toContain('Filters:');
      expect(errors).toContain('package: @example/app');
      expect(errors).toContain(`rule: ${SOURCE_ISSUE_CODES.unusedModule}`);
      expect(errors).toContain('scope: packages/app/src/theme');
      expect(errors).toContain('Matched 2 issues.');
      expect(errors).toContain('files by scope:');
      expect(errors).toContain('src/theme  2 files');
      expect(errors).toContain('packages/app/src/theme/button.ts');
      expect(errors).toContain('packages/app/src/theme/card.ts');
      expect(errors).not.toContain('packages/app/src/other.ts');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('explains unmatched source issue filters', async () => {
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
        runSourceCheck(fixture.config, {
          report: {
            command: 'limina check',
            files: ['packages/app/src/missing.ts'],
            rules: ['LIMINA_SOURCE_UNUSED_MODUL'],
            verbose: true,
          },
        }),
      ).resolves.toBe(false);

      const errors = errorSpy.mock.calls.join('\n');

      expect(errors).toContain(
        'Unknown issue rule: LIMINA_SOURCE_UNUSED_MODUL',
      );
      expect(errors).toContain(`  - ${SOURCE_ISSUE_CODES.unusedModule}`);
      expect(errors).toContain('No issues matched the selected filters.');
      expect(errors).toContain('Available packages with issues:');
      expect(errors).toContain('  - @example/app');
      expect(errors).toContain('Available rules with issues:');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('does not report unused source modules for no-exports owners', async () => {
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

  it('accepts source modules reachable from package bins', async () => {
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
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts source modules reachable from package scripts', async () => {
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
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts source modules reachable from additional entry globs', async () => {
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
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows configured unused source modules with a reason', async () => {
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
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
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
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
      const errors = errorSpy.mock.calls.join('\n');

      expect(errors).toContain('Invalid source Knip entry config  1 issue');
      expect(errors).toContain('source.knip.workspaces["@example/app"].entry');
      expect(errors).toContain('reason must be a non-empty string');
      expect(errors).toContain(
        'files must be a non-empty array of workspace-root-relative glob patterns',
      );
      expect(errors).toContain('../outside.ts');
      expect(errors).toContain(
        'file patterns must stay inside the keyed package directory',
      );
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('rejects unsupported workspace tsConfig configs', async () => {
    const errorSpy = vi
      .spyOn(SourceLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createWorkspacePackageFiles({
        appSource: "export { internalValue } from '@example/internal';\n",
      }),
      {
        source: {
          knip: {
            workspaces: {
              '@example/app': {
                tsConfig: '../tsconfig.dts.json',
              },
              '@example/internal': {
                tsConfig: ['tsconfig.dts.json'],
              } as unknown as SourceKnipWorkspaceConfig,
            },
          },
        } as unknown as SourceCheckConfig,
      },
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
      const errors = errorSpy.mock.calls.join('\n');

      expect(errors).toContain(
        'Unsupported source Knip workspace config  1 issue',
      );
      expect(errors).toContain('package: @example/app');
      expect(errors).toContain('package: @example/internal');
      expect(errors).toContain(
        'source.knip.workspaces["@example/app"].tsConfig',
      );
      expect(errors).toContain(
        'source.knip.workspaces["@example/internal"].tsConfig',
      );
      expect(errors).toContain('tsConfig is no longer supported');
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
        reason: 'Wrong source owner.',
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
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
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

  it('rejects usage tsconfigs that include files from another source owner', async () => {
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

describe('runSourceCheck workspace regions', () => {
  function getDiagnosticLines(
    issues: SourceCheckIssue[],
    code: string,
  ): string[] | undefined {
    const issue = issues.find((candidate) => candidate.code === code);

    return issue && 'evidence' in issue
      ? issue.evidence?.[0]?.lines
      : undefined;
  }

  function getDiagnosticLineGroups(
    issues: SourceCheckIssue[],
    code: string,
  ): string[][] {
    return issues
      .filter((candidate) => candidate.code === code)
      .flatMap((issue) =>
        'evidence' in issue && issue.evidence?.[0]?.lines
          ? [issue.evidence[0].lines]
          : [],
      );
  }

  it('reports nested pnpm workspace roots inside current packages', async () => {
    const fixture = await createFixture(
      {
        ...createPackageFixture({
          source: 'export const value = 1;\n',
        }),
        'app/fixture/pnpm-workspace.yaml': 'packages: []\n',
      },
      {
        source: {
          knip: false,
        },
      },
    );
    const sourceIssues: SourceCheckIssue[] = [];
    const infoSpy = vi.spyOn(SourceLogger, 'info').mockImplementation(() => {});

    try {
      await expect(
        runSourceCheck(fixture.config, {
          clearScreen: false,
          deferSnapshot: true,
          report: { defer: true },
          sourceIssues,
        }),
      ).resolves.toBe(false);

      expect(sourceIssues.map((issue) => issue.code)).toContain(
        'LIMINA_WORKSPACE_REGION_OVERLAP',
      );
      expect(
        getDiagnosticLines(sourceIssues, 'LIMINA_WORKSPACE_REGION_OVERLAP'),
      ).toEqual(expect.arrayContaining(['  nested workspace: app/fixture']));
    } finally {
      infoSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('suppresses nested pnpm workspace overlap with explicit region exclusion', async () => {
    const fixture = await createFixture(
      {
        ...createPackageFixture({
          source: 'export const value = 1;\n',
        }),
        'app/fixture/pnpm-workspace.yaml': 'packages: []\n',
      },
      {
        source: {
          knip: false,
        },
      },
    );
    const infoSpy = vi.spyOn(SourceLogger, 'info').mockImplementation(() => {});

    try {
      fixture.config.regions = {
        exclude: [
          {
            include: ['app/fixture/**'],
            reason: 'Fixture workspace.',
          },
        ],
      };

      await expect(
        runSourceCheck(fixture.config, {
          clearScreen: false,
          deferSnapshot: true,
          report: { defer: true },
        }),
      ).resolves.toBe(true);
    } finally {
      infoSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('rejects explicit checker entries at an exact nested workspace overlap', async () => {
    const fixture = await createFixture(
      {
        ...createPackageFixture({
          source: 'export const value = 1;\n',
        }),
        'app/pnpm-workspace.yaml': 'packages: []\n',
      },
      {
        source: {
          knip: false,
        },
      },
    );
    const issues: LiminaCheckIssue[] = [];
    const infoSpy = vi.spyOn(SourceLogger, 'info').mockImplementation(() => {});

    try {
      await expect(
        runSourceCheck(fixture.config, {
          clearScreen: false,
          deferSnapshot: true,
          issues,
          report: { defer: true },
        }),
      ).resolves.toBe(false);

      expect(issues.map((issue) => issue.code)).toContain(
        'LIMINA_GRAPH_PREPARE_FAILED',
      );
      expect(issues[0]?.detailLines).toEqual(
        expect.arrayContaining([
          'Checker include matched source config outside activated workspace package regions:',
          '  config: app/tsconfig.json',
        ]),
      );
    } finally {
      infoSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('does not let exclusion authorize an explicit checker entry', async () => {
    const fixture = await createFixture(
      {
        ...createPackageFixture({
          source: 'export const value = 1;\n',
        }),
        'app/pnpm-workspace.yaml': 'packages: []\n',
      },
      {
        source: {
          knip: false,
        },
      },
    );
    const issues: LiminaCheckIssue[] = [];
    const infoSpy = vi.spyOn(SourceLogger, 'info').mockImplementation(() => {});

    try {
      fixture.config.regions = {
        exclude: [
          {
            include: ['app/**'],
            reason: 'Nested app workspace is checked separately.',
          },
        ],
      };

      await expect(
        runSourceCheck(fixture.config, {
          clearScreen: false,
          deferSnapshot: true,
          issues,
          report: { defer: true },
        }),
      ).resolves.toBe(false);

      expect(issues.map((issue) => issue.code)).toContain(
        'LIMINA_GRAPH_PREPARE_FAILED',
      );
      expect(issues[0]?.detailLines).toEqual(
        expect.arrayContaining([
          'Checker include matched source config outside activated workspace package regions:',
          '  config: app/tsconfig.json',
        ]),
      );
    } finally {
      infoSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('reports duplicate non-root package ownership across workspace regions', async () => {
    const fixture = await createFixture(
      {
        ...createPackageFixture({
          source: 'export const value = 1;\n',
        }),
        'packages/a/inner/x/package.json': stringifyConfig({
          name: '@example/x',
          private: true,
        }),
        'packages/a/package.json': stringifyConfig({
          name: '@example/a',
          private: true,
        }),
        'packages/a/pnpm-workspace.yaml': 'packages:\n  - inner/*\n',
        'pnpm-workspace.yaml':
          'packages:\n  - app\n  - packages/a\n  - packages/a/inner/*\n',
      },
      {
        source: {
          knip: false,
        },
      },
    );
    const sourceIssues: SourceCheckIssue[] = [];
    const infoSpy = vi.spyOn(SourceLogger, 'info').mockImplementation(() => {});

    try {
      await expect(
        runSourceCheck(fixture.config, {
          clearScreen: false,
          deferSnapshot: true,
          report: { defer: true },
          sourceIssues,
        }),
      ).resolves.toBe(false);

      expect(
        getDiagnosticLineGroups(
          sourceIssues,
          'LIMINA_WORKSPACE_REGION_OVERLAP',
        ),
      ).toContainEqual(
        expect.arrayContaining([
          'Duplicate pnpm workspace package ownership across workspace regions:',
          '  package: packages/a/inner/x',
          '  owning region: .',
          '  owning region: packages/a',
        ]),
      );
    } finally {
      infoSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('suppresses duplicate package ownership for explicitly excluded nested regions', async () => {
    const fixture = await createFixture(
      {
        ...createPackageFixture({
          source: 'export const value = 1;\n',
        }),
        'packages/a/inner/x/package.json': stringifyConfig({
          name: '@example/x',
          private: true,
        }),
        'packages/a/package.json': stringifyConfig({
          name: '@example/a',
          private: true,
        }),
        'packages/a/pnpm-workspace.yaml': 'packages:\n  - inner/*\n',
        'pnpm-workspace.yaml':
          'packages:\n  - app\n  - packages/a\n  - packages/a/inner/*\n',
      },
      {
        source: {
          knip: false,
        },
      },
    );
    const sourceIssues: SourceCheckIssue[] = [];
    const infoSpy = vi.spyOn(SourceLogger, 'info').mockImplementation(() => {});

    try {
      fixture.config.regions = {
        exclude: [
          {
            include: ['packages/a/**'],
            reason: 'Nested workspace is checked separately.',
          },
        ],
      };

      await expect(
        runSourceCheck(fixture.config, {
          clearScreen: false,
          deferSnapshot: true,
          report: { defer: true },
          sourceIssues,
        }),
      ).resolves.toBe(true);

      expect(
        getDiagnosticLineGroups(
          sourceIssues,
          'LIMINA_WORKSPACE_REGION_OVERLAP',
        ).some((lines) =>
          lines.includes(
            'Duplicate pnpm workspace package ownership across workspace regions:',
          ),
        ),
      ).toBe(false);
    } finally {
      infoSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('terminates when a non-excluded nested workspace cannot be inspected', async () => {
    const fixture = await createFixture(
      {
        ...createPackageFixture({
          source: 'export const value = 1;\n',
        }),
        'app/fixture/package.json': '{\n',
        'app/fixture/pnpm-workspace.yaml': 'packages:\n  - .\n',
      },
      {
        source: {
          knip: false,
        },
      },
    );
    const infoSpy = vi.spyOn(SourceLogger, 'info').mockImplementation(() => {});

    try {
      await expect(
        runSourceCheck(fixture.config, {
          clearScreen: false,
          deferSnapshot: true,
          report: { defer: true },
        }),
      ).rejects.toThrow(
        /Failed to inspect nested pnpm workspace region[\s\S]*app\/fixture/u,
      );
    } finally {
      infoSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('fails source check when graph preparation sees imports into excluded nested regions', async () => {
    const fixture = await createFixture(
      {
        ...createPackageFixture({
          source:
            "import { fixtureValue } from '../fixture/pkg/src/value';\nexport const value = fixtureValue;\n",
        }),
        'app/fixture/pkg/src/value.ts': 'export const fixtureValue = 1;\n',
        'app/fixture/pnpm-workspace.yaml': 'packages:\n  - pkg\n',
      },
      {
        source: {
          knip: false,
        },
      },
    );
    const issues: LiminaCheckIssue[] = [];
    const infoSpy = vi.spyOn(SourceLogger, 'info').mockImplementation(() => {});

    try {
      fixture.config.regions = {
        exclude: [
          {
            include: ['app/fixture/**'],
            reason: 'Fixture workspace.',
          },
        ],
      };

      await expect(
        runSourceCheck(fixture.config, {
          clearScreen: false,
          deferSnapshot: true,
          issues,
          report: { defer: true },
        }),
      ).resolves.toBe(false);

      expect(issues.map((issue) => issue.code)).toContain(
        'LIMINA_GRAPH_PREPARE_FAILED',
      );
      expect(issues[0]?.detailLines).toEqual(
        expect.arrayContaining([
          'Generated graph import crosses governance boundary:',
          '  resolved file: app/fixture/pkg/src/value.ts',
          '  boundary kind: pnpm-workspace',
          '  boundary root: app/fixture',
          '  excluded boundary reason: Fixture workspace.',
        ]),
      );
    } finally {
      infoSpy.mockRestore();
      await fixture.cleanup();
    }
  });
});
