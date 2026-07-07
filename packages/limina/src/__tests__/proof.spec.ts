import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runProofCheck } from '../commands/proof';
import { ProofLogger } from '../logger';
import {
  type LiminaCheckIssue,
  readCheckIssueSnapshot,
} from '../source-check/snapshot';

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

function stringifyConfig(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function getFixtureWorkspacePackageManifestPath(
  relativePath: string,
): string | null {
  const segments = relativePath.split('/');

  if (
    segments[0] !== 'packages' ||
    !segments[1] ||
    segments.length < 3 ||
    segments[2] === 'package.json'
  ) {
    return null;
  }

  return `packages/${segments[1]}/package.json`;
}

function createFixtureFiles(
  files: Record<string, string>,
): Record<string, string> {
  const gitignore = [
    'package.json',
    'tsconfig*.json',
    '**/tsconfig*.json',
    files['.gitignore'] ?? '',
  ].join('\n');
  const packageManifests: Record<string, string> = {
    'package.json': stringifyConfig({
      name: 'fixture-root',
      private: true,
    }),
  };

  for (const relativePath of Object.keys(files)) {
    const packageJsonPath =
      getFixtureWorkspacePackageManifestPath(relativePath);

    if (!packageJsonPath || Object.hasOwn(files, packageJsonPath)) {
      continue;
    }

    const packageDirectory = path.posix.dirname(packageJsonPath);
    const packageName = path.posix.basename(packageDirectory);

    packageManifests[packageJsonPath] = stringifyConfig({
      name: `@fixture/${packageName}`,
      private: true,
    });
  }

  return {
    'pnpm-workspace.yaml': 'packages:\n  - app\n  - packages/*\n',
    ...packageManifests,
    ...files,
    '.gitignore': gitignore,
  };
}

async function createFixture(files: Record<string, string>): Promise<{
  cleanup: () => Promise<void>;
  config: ResolvedLiminaConfig;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-proof-')),
  );
  const fixtureFiles = createFixtureFiles(files);

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
        checkers: {
          typescript: {
            preset: 'tsc',
            include: ['tsconfig.json', '**/tsconfig.json'],
          },
        },
      },
      configPath: path.join(rootDir, 'limina.config.mjs'),
      rootDir,
    },
    rootDir,
  };
}

function createPassingFiles(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    'packages/pkg/src/index.ts': 'export const value = 1;\n',
    'packages/pkg/tsconfig.json': JSON.stringify({
      compilerOptions: {
        lib: ['ES2023'],
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        target: 'ES2023',
        types: [],
      },
      include: ['src/**/*.ts'],
    }),
    'tsconfig.json': JSON.stringify({
      files: [],
      references: [
        {
          path: './packages/pkg/tsconfig.json',
        },
      ],
    }),
    ...overrides,
  };
}

function createSingleEnvironmentFiles(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    'packages/pkg/src/index.ts': 'export const value = 1;\n',
    'packages/pkg/tsconfig.json': JSON.stringify({
      compilerOptions: {
        lib: ['ES2023'],
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        target: 'ES2023',
        types: [],
      },
      include: ['src/**/*.ts'],
    }),
    'tsconfig.json': JSON.stringify({
      files: [],
      references: [
        {
          path: './packages/pkg/tsconfig.json',
        },
      ],
    }),
    ...overrides,
  };
}

function createMultiEnvironmentFiles(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return createPassingFiles({
    'packages/pkg/tsconfig.lib.json': JSON.stringify({
      compilerOptions: {
        lib: ['ES2023'],
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        target: 'ES2023',
        types: [],
      },
      include: ['src/**/*.ts'],
    }),
    'packages/pkg/tsconfig.test.json': JSON.stringify({
      compilerOptions: {
        lib: ['ES2023'],
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        target: 'ES2023',
        types: [],
      },
      include: ['src/**/*.ts'],
    }),
    'packages/pkg/tsconfig.json': JSON.stringify({
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
    ...overrides,
  });
}

function createCheckerGraphCoverageProofGeneratedGraph(
  rootDir: string,
): GeneratedTsconfigGraphResult {
  const checkerEntryPath = path.join(
    rootDir,
    '.limina/tsconfig.typescript.build.json',
  );

  return {
    changed: false,
    checkerEntries: new Map([['typescript', checkerEntryPath]]),
    checkers: [
      {
        exclude: [],
        extensions: [],
        include: ['tsconfig.json', '**/tsconfig.json'],
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

describe('runProofCheck dts config semantics', () => {
  it('accepts a single-environment dts leaf paired with default tsconfig.json', async () => {
    const fixture = await createFixture(createPassingFiles());

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects missing typecheck declaration companions', async () => {
    const fixture = await createFixture(createMultiEnvironmentFiles());

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores inert dts leaves that do not transitively extend their companion', async () => {
    const fixture = await createFixture(
      createSingleEnvironmentFiles({
        'packages/pkg/tsconfig.dts.json': JSON.stringify({
          compilerOptions: {
            composite: true,
            declaration: true,
            emitDeclarationOnly: true,
            lib: ['ES2023'],
            module: 'ESNext',
            moduleResolution: 'bundler',
            noEmit: false,
            outDir: './.tsbuild',
            rootDir: 'src',
            strict: true,
            target: 'ES2023',
            tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
            types: [],
          },
          include: ['src/**/*.ts'],
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores inert declaration helper configs outside managed entries', async () => {
    const fixture = await createFixture(
      createSingleEnvironmentFiles({
        'packages/pkg/tsconfig.dts.base.json': JSON.stringify({
          extends: './tsconfig.json',
        }),
        'packages/pkg/tsconfig.dts.json': JSON.stringify({
          extends: './tsconfig.dts.base.json',
          compilerOptions: {
            composite: true,
            declaration: true,
            emitDeclarationOnly: true,
            noEmit: false,
            outDir: './.tsbuild',
            rootDir: 'src',
            tsBuildInfoFile: './.tsbuild/build.tsbuildinfo',
          },
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores inert build graph references to ordinary configs', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'tsconfig.extra.build.json': JSON.stringify({
          files: [],
          references: [
            {
              path: './packages/pkg/tsconfig.json',
            },
          ],
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects duplicate ordinary typecheck ownership for implementation sources', async () => {
    const fixture = await createFixture(createMultiEnvironmentFiles());

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports duplicate checker graph coverage for implementation sources with its own issue code', async () => {
    const fixture = await createFixture({
      '.limina/tsconfig.typescript.build.json': JSON.stringify({
        files: [],
        references: [
          {
            path: '../packages/pkg/tsconfig.alpha.dts.json',
          },
          {
            path: '../packages/pkg/tsconfig.beta.dts.json',
          },
        ],
      }),
      'packages/pkg/src/shared.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.alpha.dts.json': JSON.stringify({
        extends: './tsconfig.alpha.json',
        compilerOptions: {
          composite: true,
          declaration: true,
          emitDeclarationOnly: true,
          noEmit: false,
          outDir: './.tsbuild/alpha',
          tsBuildInfoFile: './.tsbuild/alpha.tsbuildinfo',
        },
        liminaOptions: {
          sourceConfig: './tsconfig.alpha.json',
        },
      }),
      'packages/pkg/tsconfig.alpha.json': JSON.stringify({
        compilerOptions: {
          lib: ['ES2023'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/shared.ts'],
      }),
      'packages/pkg/tsconfig.beta.dts.json': JSON.stringify({
        extends: './tsconfig.beta.json',
        compilerOptions: {
          composite: true,
          declaration: true,
          emitDeclarationOnly: true,
          noEmit: false,
          outDir: './.tsbuild/beta',
          tsBuildInfoFile: './.tsbuild/beta.tsbuildinfo',
        },
        liminaOptions: {
          sourceConfig: './tsconfig.beta.json',
        },
      }),
      'packages/pkg/tsconfig.beta.json': JSON.stringify({
        compilerOptions: {
          lib: ['ES2023'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/shared.ts'],
      }),
      'packages/pkg/tsconfig.json': JSON.stringify({
        files: [],
        references: [
          {
            path: './tsconfig.alpha.json',
          },
          {
            path: './tsconfig.beta.json',
          },
        ],
      }),
      'tsconfig.json': JSON.stringify({
        files: [],
        references: [
          {
            path: './packages/pkg/tsconfig.json',
          },
        ],
      }),
    });
    const issues: LiminaCheckIssue[] = [];

    try {
      await expect(
        runProofCheck(fixture.config, {
          deferSnapshot: true,
          generatedGraphProvider: async () =>
            createCheckerGraphCoverageProofGeneratedGraph(fixture.rootDir),
          issues,
          report: {
            defer: true,
          },
        }),
      ).resolves.toBe(false);

      expect(issues).toContainEqual(
        expect.objectContaining({
          code: 'LIMINA_PROOF_DUPLICATE_GRAPH_COVERAGE',
          filePath: 'packages/pkg/src/shared.ts',
          task: 'proof:check',
          title: 'Duplicate checker graph coverage',
        }),
      );
      expect(issues).not.toContainEqual(
        expect.objectContaining({
          code: 'LIMINA_PROOF_DUPLICATE_SOURCE_OWNER',
          title: 'Duplicate checker graph coverage',
        }),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows shared declaration input files across generated checker graph dts configs', async () => {
    const fixture = await createFixture({
      '.limina/tsconfig.typescript.build.json': JSON.stringify({
        files: [],
        references: [
          {
            path: '../packages/pkg/tsconfig.lib.dts.json',
          },
          {
            path: '../packages/pkg/tsconfig.test.dts.json',
          },
        ],
      }),
      'packages/pkg/src/lib.ts': 'export const lib = 1;\n',
      'packages/pkg/src/shared.d.cts':
        'declare const sharedCommonJsDeclaration: string;\n',
      'packages/pkg/src/shared.d.mts':
        'declare const sharedModuleDeclaration: string;\n',
      'packages/pkg/src/shared.d.ts':
        'declare const sharedGlobalDeclaration: string;\n',
      'packages/pkg/test/index.ts': 'export const test = 1;\n',
      'packages/pkg/tsconfig.lib.dts.json': JSON.stringify({
        extends: './tsconfig.lib.json',
        compilerOptions: {
          composite: true,
          declaration: true,
          emitDeclarationOnly: true,
          noEmit: false,
          outDir: './.tsbuild/lib',
          tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
        },
        liminaOptions: {
          sourceConfig: './tsconfig.lib.json',
        },
      }),
      'packages/pkg/tsconfig.lib.json': JSON.stringify({
        compilerOptions: {
          lib: ['ES2023'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: [
          'src/lib.ts',
          'src/shared.d.cts',
          'src/shared.d.mts',
          'src/shared.d.ts',
        ],
      }),
      'packages/pkg/tsconfig.test.dts.json': JSON.stringify({
        extends: './tsconfig.test.json',
        compilerOptions: {
          composite: true,
          declaration: true,
          emitDeclarationOnly: true,
          noEmit: false,
          outDir: './.tsbuild/test',
          tsBuildInfoFile: './.tsbuild/test.tsbuildinfo',
        },
        liminaOptions: {
          sourceConfig: './tsconfig.test.json',
        },
      }),
      'packages/pkg/tsconfig.test.json': JSON.stringify({
        compilerOptions: {
          lib: ['ES2023'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: [
          'test/index.ts',
          'src/shared.d.cts',
          'src/shared.d.mts',
          'src/shared.d.ts',
        ],
      }),
      'packages/pkg/tsconfig.json': JSON.stringify({
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
      'tsconfig.json': JSON.stringify({
        files: [],
        references: [
          {
            path: './packages/pkg/tsconfig.json',
          },
        ],
      }),
    });
    const issues: LiminaCheckIssue[] = [];

    try {
      await expect(
        runProofCheck(fixture.config, {
          deferSnapshot: true,
          generatedGraphProvider: async () =>
            createCheckerGraphCoverageProofGeneratedGraph(fixture.rootDir),
          issues,
          report: {
            defer: true,
          },
        }),
      ).resolves.toBe(true);

      expect(issues).not.toContainEqual(
        expect.objectContaining({
          code: 'LIMINA_PROOF_DUPLICATE_GRAPH_COVERAGE',
        }),
      );
      expect(issues).not.toContainEqual(
        expect.objectContaining({
          filePath: 'packages/pkg/src/shared.d.cts',
          title: 'Duplicate checker graph coverage',
        }),
      );
      expect(issues).not.toContainEqual(
        expect.objectContaining({
          filePath: 'packages/pkg/src/shared.d.mts',
          title: 'Duplicate checker graph coverage',
        }),
      );
      expect(issues).not.toContainEqual(
        expect.objectContaining({
          filePath: 'packages/pkg/src/shared.d.ts',
          title: 'Duplicate checker graph coverage',
        }),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows pnpm-like shared typings across generated checker graph dts configs', async () => {
    const fixture = await createFixture({
      '.limina/tsconfig.typescript.build.json': JSON.stringify({
        files: [],
        references: [
          {
            path: '../packages/pkg/tsconfig.lib.dts.json',
          },
          {
            path: '../packages/pkg/tsconfig.test.dts.json',
          },
        ],
      }),
      'packages/pkg/__typings__/index.d.ts':
        'export interface SharedIndexTyping { value: string; }\n',
      'packages/pkg/__typings__/local.d.ts':
        'export interface SharedLocalTyping { value: string; }\n',
      'packages/pkg/__typings__/typed.d.ts':
        'export interface SharedTypedTyping { value: string; }\n',
      'packages/pkg/src/lib.ts': 'export const lib = 1;\n',
      'packages/pkg/test/index.ts': 'export const test = 1;\n',
      'packages/pkg/tsconfig.lib.dts.json': JSON.stringify({
        extends: './tsconfig.lib.json',
        compilerOptions: {
          composite: true,
          declaration: true,
          emitDeclarationOnly: true,
          noEmit: false,
          outDir: './.tsbuild/lib',
          tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
        },
        liminaOptions: {
          sourceConfig: './tsconfig.lib.json',
        },
      }),
      'packages/pkg/tsconfig.lib.json': JSON.stringify({
        compilerOptions: {
          lib: ['ES2023'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: [
          '__typings__/index.d.ts',
          '__typings__/local.d.ts',
          '__typings__/typed.d.ts',
          'src/lib.ts',
        ],
      }),
      'packages/pkg/tsconfig.test.dts.json': JSON.stringify({
        extends: './tsconfig.test.json',
        compilerOptions: {
          composite: true,
          declaration: true,
          emitDeclarationOnly: true,
          noEmit: false,
          outDir: './.tsbuild/test',
          tsBuildInfoFile: './.tsbuild/test.tsbuildinfo',
        },
        liminaOptions: {
          sourceConfig: './tsconfig.test.json',
        },
      }),
      'packages/pkg/tsconfig.test.json': JSON.stringify({
        compilerOptions: {
          lib: ['ES2023'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: [
          '__typings__/index.d.ts',
          '__typings__/local.d.ts',
          '__typings__/typed.d.ts',
          'test/index.ts',
        ],
      }),
      'packages/pkg/tsconfig.json': JSON.stringify({
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
      'tsconfig.json': JSON.stringify({
        files: [],
        references: [
          {
            path: './packages/pkg/tsconfig.json',
          },
        ],
      }),
    });
    const issues: LiminaCheckIssue[] = [];

    try {
      await expect(
        runProofCheck(fixture.config, {
          deferSnapshot: true,
          generatedGraphProvider: async () =>
            createCheckerGraphCoverageProofGeneratedGraph(fixture.rootDir),
          issues,
          report: {
            defer: true,
          },
        }),
      ).resolves.toBe(true);

      for (const filePath of [
        'packages/pkg/__typings__/index.d.ts',
        'packages/pkg/__typings__/local.d.ts',
        'packages/pkg/__typings__/typed.d.ts',
      ]) {
        expect(issues).not.toContainEqual(
          expect.objectContaining({
            filePath,
            title: 'Duplicate checker graph coverage',
          }),
        );
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores inert build graph aggregators with source inputs or compilerOptions', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'tsconfig.build.json': JSON.stringify({
          compilerOptions: {
            strict: true,
          },
          files: [],
          include: ['packages/pkg/src/**/*.ts'],
          references: [
            {
              path: './packages/pkg/tsconfig.lib.dts.json',
            },
          ],
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores inert dts leaves without declaration emit semantics', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/tsconfig.lib.dts.json': JSON.stringify({
          extends: './tsconfig.json',
          compilerOptions: {
            composite: true,
            noEmit: false,
            outDir: './.tsbuild',
            rootDir: 'src',
            tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
          },
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores inert multi-environment directories outside managed entries', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/tsconfig.lib.dts.json': JSON.stringify({
          extends: './tsconfig.lib.json',
          compilerOptions: {
            composite: true,
            declaration: true,
            emitDeclarationOnly: true,
            noEmit: false,
            outDir: './.tsbuild',
            rootDir: 'src',
            tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
          },
        }),
        'packages/pkg/tsconfig.lib.json': JSON.stringify({
          compilerOptions: {
            lib: ['ES2023'],
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['src/**/*.ts'],
        }),
        'packages/pkg/tsconfig.test.json': JSON.stringify({
          compilerOptions: {
            lib: ['ES2023'],
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['src/**/*.ts'],
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects default source tsconfig files that still declare project references', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'base.json': JSON.stringify({}),
        'tsconfig.json': JSON.stringify({
          extends: './base.json',
          compilerOptions: {
            noEmit: true,
          },
          files: ['packages/pkg/src/index.ts'],
          include: ['packages/pkg/src/**/*.ts'],
          references: [
            {
              path: './packages/pkg/tsconfig.json',
            },
          ],
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).rejects.toThrow(
        'Source typecheck config declares project references',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports missing local typecheck config files', async () => {
    const files = createPassingFiles();
    delete files['packages/pkg/tsconfig.json'];
    const fixture = await createFixture(files);

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores inert dts compiler option drift from the local typecheck config', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/tsconfig.lib.dts.json': JSON.stringify({
          extends: './tsconfig.json',
          compilerOptions: {
            composite: true,
            lib: ['ES2020'],
            moduleResolution: 'node10',
            noEmit: false,
            outDir: './.tsbuild',
            strict: false,
            tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
            types: ['node'],
          },
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores inert declaration-only compiler option extensions', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/tsconfig.lib.dts.json': JSON.stringify({
          extends: './tsconfig.json',
          compilerOptions: {
            composite: true,
            declaration: true,
            declarationMap: false,
            emitDeclarationOnly: true,
            incremental: true,
            noEmit: false,
            outDir: './.tsbuild',
            rootDir: 'src',
            sourceMap: false,
            tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
          },
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores inert dts and local file set drift', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/src/extra.ts': 'export const extra = 2;\n',
        'packages/pkg/tsconfig.lib.dts.json': JSON.stringify({
          extends: './tsconfig.json',
          compilerOptions: {
            composite: true,
            noEmit: false,
            outDir: './.tsbuild',
            tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
          },
          include: ['src/index.ts'],
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores inert paths and baseUrl drift because module resolution is checked by graph validation', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/tsconfig.lib.dts.json': JSON.stringify({
          extends: './tsconfig.json',
          compilerOptions: {
            baseUrl: '.',
            composite: true,
            declaration: true,
            emitDeclarationOnly: true,
            noEmit: false,
            outDir: './.tsbuild',
            paths: {
              '#internal/*': ['./src/*'],
            },
            tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
          },
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects declaration configs referenced from default typecheck aggregators', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/tsconfig.json': JSON.stringify({
          files: [],
          references: [
            {
              path: './tsconfig.lib.dts.json',
            },
          ],
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects single-environment directories that keep a scoped local config', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/tsconfig.json': JSON.stringify({
          files: [],
          references: [
            {
              path: './tsconfig.lib.json',
            },
          ],
        }),
        'packages/pkg/tsconfig.lib.json': JSON.stringify({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['src/**/*.ts'],
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores inert duplicate same-family checker build owners', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/tsconfig.alt.dts.json': JSON.stringify({
          extends: './tsconfig.json',
          compilerOptions: {
            composite: true,
            declaration: true,
            emitDeclarationOnly: true,
            noEmit: false,
            outDir: './.tsbuild',
            rootDir: 'src',
            tsBuildInfoFile: './.tsbuild/alt.tsbuildinfo',
          },
        }),
        'tsconfig.alt.build.json': JSON.stringify({
          files: [],
          references: [
            {
              path: './packages/pkg/tsconfig.alt.dts.json',
            },
          ],
        }),
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            checkers: {
              primary: {
                preset: 'tsc',
                include: ['tsconfig.json'],
              },
              secondary: {
                preset: 'tsc',
                include: ['tsconfig.alt.json'],
              },
            },
          },
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts configured checker entries outside the root graph entry', async () => {
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.test.dts.json': JSON.stringify({
        extends: './tsconfig.test.json',
        compilerOptions: {
          composite: true,
          declaration: true,
          emitDeclarationOnly: true,
          noEmit: false,
          outDir: './.tsbuild',
          tsBuildInfoFile: './.tsbuild/test.tsbuildinfo',
        },
      }),
      'packages/pkg/tsconfig.test.json': JSON.stringify({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/pkg/tsconfig.sfc.json': JSON.stringify({
        extends: './tsconfig.test.json',
      }),
      'packages/pkg/tsconfig.sfc.dts.json': JSON.stringify({
        extends: './tsconfig.sfc.json',
        compilerOptions: {
          composite: true,
          declaration: true,
          emitDeclarationOnly: true,
          noEmit: false,
          outDir: './.tsbuild',
          tsBuildInfoFile: './.tsbuild/vue.tsbuildinfo',
        },
      }),
      'packages/pkg/tsconfig.json': JSON.stringify({
        files: [],
        references: [
          {
            path: './tsconfig.test.json',
          },
        ],
      }),
      'tsconfig.json': JSON.stringify({
        files: [],
        references: [
          {
            path: './packages/pkg/tsconfig.json',
          },
        ],
      }),
      'tsconfig.build.json': JSON.stringify({
        files: [],
        references: [
          {
            path: './packages/pkg/tsconfig.test.dts.json',
          },
        ],
      }),
    });

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            checkers: {
              ...(typeof fixture.config.config?.checkers === 'object'
                ? fixture.config.config.checkers
                : {}),
              typescript: {
                include: ['tsconfig.json'],
                preset: 'tsc',
              },
              vue: {
                include: ['packages/pkg/tsconfig.json'],
                preset: 'vue-tsc',
              },
            },
          },
        }),
      ).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports missing configured checker entry configs', async () => {
    const fixture = await createFixture(createPassingFiles());

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            checkers: {
              ...(typeof fixture.config.config?.checkers === 'object'
                ? fixture.config.config.checkers
                : {}),
              vue: {
                include: ['packages/pkg/tsconfig.missing.json'],
                preset: 'vue-tsc',
              },
            },
          },
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports source files outside checker entries and allowlist coverage', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/fixtures/uncovered.ts': 'export const uncovered = 1;\n',
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(false);

      const snapshot = await readCheckIssueSnapshot(fixture.rootDir);

      expect(snapshot?.issues).toContainEqual(
        expect.objectContaining({
          code: 'LIMINA_PROOF_UNCOVERED_SOURCE_FILE',
          filePath: 'packages/pkg/fixtures/uncovered.ts',
          fix: expect.any(String),
          reason: expect.any(String),
          scope: 'packages/pkg/fixtures',
          task: 'proof:check',
          title: 'Source file is not covered by typecheck proof',
        }),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports fixed default source extensions outside checker coverage', async () => {
    const errorSpy = vi
      .spyOn(ProofLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/fixtures/config.mjs': 'export default {};\n',
        'packages/pkg/fixtures/data.json': JSON.stringify({ ok: true }),
        'packages/pkg/fixtures/ignored.cjs': 'exports.value = 1;\n',
        'packages/pkg/fixtures/ignored.js': 'export const value = 1;\n',
        'packages/pkg/fixtures/ignored.jsx': 'export const value = <div />;\n',
        'packages/pkg/fixtures/uncovered.cts': 'export const value = 1;\n',
        'packages/pkg/fixtures/uncovered.d.cts':
          'export declare const value: number;\n',
        'packages/pkg/fixtures/uncovered.d.mts':
          'export declare const value: number;\n',
        'packages/pkg/fixtures/uncovered.mts': 'export const value = 1;\n',
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(false);
      const output = errorSpy.mock.calls.join('\n');

      expect(output).toContain('packages/pkg/fixtures/config.mjs');
      expect(output).toContain('packages/pkg/fixtures/data.json');
      expect(output).toContain('packages/pkg/fixtures/uncovered.cts');
      expect(output).toContain('packages/pkg/fixtures/uncovered.d.cts');
      expect(output).toContain('packages/pkg/fixtures/uncovered.d.mts');
      expect(output).toContain('  ... 1 more');
      expect(output).not.toContain('packages/pkg/fixtures/ignored.cjs');
      expect(output).not.toContain('packages/pkg/fixtures/ignored.js');
      expect(output).not.toContain('packages/pkg/fixtures/ignored.jsx');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('uses root gitignore patterns in the default source exclude', async () => {
    const errorSpy = vi
      .spyOn(ProofLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createPassingFiles({
        '.gitignore': 'ignored-default/*.ts\n!ignored-default/keep.ts\n',
        'ignored-default/hidden.ts': 'export const hidden = 1;\n',
        'ignored-default/keep.ts': 'export const keep = 1;\n',
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(false);
      const output = errorSpy.mock.calls.join('\n');

      expect(output).toContain('ignored-default/keep.ts');
      expect(output).not.toContain('ignored-default/hidden.ts');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('does not use root gitignore patterns when source exclude is configured', async () => {
    const errorSpy = vi
      .spyOn(ProofLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createPassingFiles({
        '.gitignore': 'ignored-default/*.ts\n',
        'ignored-default/hidden.ts': 'export const hidden = 1;\n',
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            source: {
              exclude: [],
              include: ['packages/pkg/src/**/*.ts', 'ignored-default/*.ts'],
            },
          },
        }),
      ).resolves.toBe(false);
      expect(errorSpy.mock.calls.join('\n')).toContain(
        'ignored-default/hidden.ts',
      );
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('applies required default source excludes when source exclude is omitted', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        '.git/uncovered.ts': 'export const value = 1;\n',
        '.nx/uncovered.ts': 'export const value = 1;\n',
        '.tsbuild/uncovered.ts': 'export const value = 1;\n',
        'coverage/uncovered.ts': 'export const value = 1;\n',
        'dist/uncovered.ts': 'export const value = 1;\n',
        'node_modules/uncovered.ts': 'export const value = 1;\n',
        'nx.json': JSON.stringify({ namedInputs: {} }),
        'project.json': JSON.stringify({ name: 'fixture' }),
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            source: {
              include: [
                'packages/pkg/src/**/*.ts',
                'nx.json',
                'project.json',
                'tsconfig.json',
                'tsconfig.build.json',
                'dist/**/*.ts',
                '.nx/**/*.ts',
                '.git/**/*.ts',
                '.tsbuild/**/*.ts',
                'coverage/**/*.ts',
                'node_modules/**/*.ts',
              ],
            },
          },
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports tsconfig-covered files outside the configured source boundary', async () => {
    const errorSpy = vi
      .spyOn(ProofLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/fixtures/covered.ts': 'export const covered = 1;\n',
        'packages/pkg/tsconfig.json': JSON.stringify({
          compilerOptions: {
            lib: ['ES2023'],
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['src/**/*.ts', 'fixtures/**/*.ts'],
        }),
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            source: {
              include: ['packages/pkg/src/**/*.ts'],
            },
          },
        }),
      ).resolves.toBe(false);
      expect(errorSpy.mock.calls.join('\n')).toContain(
        'Typecheck proof source boundary does not match tsconfig coverage',
      );
      expect(errorSpy.mock.calls.join('\n')).toContain(
        'packages/pkg/fixtures/covered.ts',
      );
      expect(errorSpy.mock.calls.join('\n')).toContain(
        'config.source and tsconfig*.json coverage describe different module sets',
      );
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('accepts JavaScript files included by the checker parsed project', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'tools/eslint.config.mjs': 'export default [];\n',
        'tools/tsconfig.json': JSON.stringify({
          compilerOptions: {
            allowJs: true,
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['eslint.config.mjs'],
        }),
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            source: {
              include: ['packages/pkg/src/**/*.ts', 'tools/eslint.config.mjs'],
            },
          },
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports JavaScript config files outside checker and allowlist coverage', async () => {
    const errorSpy = vi
      .spyOn(ProofLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createPassingFiles({
        'eslint.config.mjs': 'export default [];\n',
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            source: {
              include: ['packages/pkg/src/**/*.ts', 'eslint.config.mjs'],
            },
          },
        }),
      ).resolves.toBe(false);
      expect(errorSpy.mock.calls.join('\n')).toContain(
        'Source file is not covered by typecheck proof',
      );
      expect(errorSpy.mock.calls.join('\n')).toContain('eslint.config.mjs');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('uses explicit source include as the complete source boundary', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'docs/page.md': '# page\n',
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            source: {
              include: ['docs/*.md'],
            },
          },
        }),
      ).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports allowlist entries outside the configured source boundary', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/fixtures/ignored.md': 'not part of source proof\n',
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          proof: {
            allowlist: [
              {
                file: 'packages/pkg/fixtures/ignored.md',
                reason: 'markdown files are outside proof source boundary',
              },
            ],
          },
        }),
      ).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts source files covered by the proof allowlist', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/fixtures/allowed.ts': 'export const allowed = 1;\n',
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          proof: {
            allowlist: [
              {
                file: 'packages/pkg/fixtures/allowed.ts',
                reason:
                  'fixture intentionally lives outside TypeScript entries',
              },
            ],
          },
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts Vue source files covered by a checker entry', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'tools/covered.vue':
          '<script setup lang="ts">const value = 1;</script>\n',
        'tools/tsconfig.json': JSON.stringify({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['covered.vue'],
        }),
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            checkers: {
              typescript: {
                exclude: ['**/tsconfig*.dts.json', '**/tsconfig*.build.json'],
                include: ['packages/pkg/tsconfig.json'],
                preset: 'tsc',
              },
              vue: {
                include: ['tools/tsconfig.json'],
                preset: 'vue-tsc',
              },
            },
          },
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses Vue checker extensions in the default source include', async () => {
    const errorSpy = vi
      .spyOn(ProofLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createPassingFiles({
        'tools/covered.vue':
          '<script setup lang="ts">const value = 1;</script>\n',
        'tools/tsconfig.json': JSON.stringify({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['covered.vue'],
        }),
        'tools/uncovered.vue':
          '<script setup lang="ts">const value = 2;</script>\n',
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            checkers: {
              typescript: {
                exclude: ['**/tsconfig*.dts.json', '**/tsconfig*.build.json'],
                include: ['packages/pkg/tsconfig.json'],
                preset: 'tsc',
              },
              vue: {
                include: ['tools/tsconfig.json'],
                preset: 'vue-tsc',
              },
            },
          },
        }),
      ).resolves.toBe(false);
      expect(errorSpy.mock.calls.join('\n')).toContain('tools/uncovered.vue');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('uses Svelte checker extensions in the default source include', async () => {
    const errorSpy = vi
      .spyOn(ProofLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createPassingFiles({
        'tools/covered.svelte': '<script>const value = 1;</script>\n',
        'tools/tsconfig.json': JSON.stringify({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['covered.svelte'],
        }),
        'tools/uncovered.svelte': '<script>const value = 2;</script>\n',
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            checkers: {
              typescript: {
                exclude: ['**/tsconfig*.dts.json', '**/tsconfig*.build.json'],
                include: ['packages/pkg/tsconfig.json'],
                preset: 'tsc',
              },
              svelte: {
                include: ['tools/tsconfig.json'],
                preset: 'svelte-check',
              },
            },
          },
        }),
      ).resolves.toBe(false);
      expect(errorSpy.mock.calls.join('\n')).toContain(
        'tools/uncovered.svelte',
      );
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('accepts TypeScript source covered by a vue-tsgo checker entry', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'tools/covered.vue':
          '<script setup lang="ts">import "./helper";</script>\n',
        'tools/helper.ts': 'export const helper = 1;\n',
        'tools/widget.tsx': 'export const widget = <div />;\n',
        'tools/tsconfig.json': JSON.stringify({
          compilerOptions: {
            jsx: 'preserve',
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['covered.vue', 'helper.ts', 'widget.tsx'],
        }),
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            checkers: {
              typescript: {
                exclude: ['**/tsconfig*.dts.json', '**/tsconfig*.build.json'],
                include: ['packages/pkg/tsconfig.json'],
                preset: 'tsc',
              },
              vue: {
                include: ['tools/tsconfig.json'],
                preset: 'vue-tsgo',
              },
            },
          },
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not require coverage for excluded config json files', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'package.json': JSON.stringify({
          name: 'fixture',
        }),
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            source: {
              include: ['packages/pkg/src/**/*.ts', 'package.json'],
              exclude: ['package.json'],
            },
          },
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not require a shared typecheck root config', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'tsconfig.json': JSON.stringify({
          files: [],
          references: [],
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects project references in source typecheck leaf configs', async () => {
    const fixture = await createFixture({
      'packages/dep/src/index.ts': 'export const depValue = 1;\n',
      'packages/dep/tsconfig.json': JSON.stringify({
        compilerOptions: {
          lib: ['ES2023'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/test/index.ts': 'export const testValue = 1;\n',
      'packages/pkg/tsconfig.json': JSON.stringify({
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
      'packages/pkg/tsconfig.lib.json': JSON.stringify({
        compilerOptions: {
          lib: ['ES2023'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
        references: [
          {
            path: '../dep/tsconfig.json',
          },
        ],
      }),
      'packages/pkg/tsconfig.test.json': JSON.stringify({
        compilerOptions: {
          lib: ['ES2023'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['test/**/*.ts'],
      }),
      'tsconfig.json': JSON.stringify({
        files: [],
        references: [
          {
            path: './packages/dep/tsconfig.json',
          },
          {
            path: './packages/pkg/tsconfig.json',
          },
        ],
      }),
    });

    try {
      await expect(runProofCheck(fixture.config)).rejects.toThrow(
        'Source typecheck config declares project references',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts solution-style default tsconfig references', async () => {
    const fixture = await createFixture(createPassingFiles());

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects default typecheck tsconfig files with empty references', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'root.ts': 'export const rootValue = 1;\n',
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            lib: ['ES2023'],
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['root.ts'],
          references: [],
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).rejects.toThrow(
        'Source typecheck config declares project references',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps rejecting non-pure solution-style tsconfig aggregators', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            strict: true,
          },
          files: [],
          references: [
            {
              path: './packages/pkg/tsconfig.json',
            },
          ],
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects implicitRefs on solution-style tsconfig aggregators', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'tsconfig.json': JSON.stringify({
          files: [],
          liminaOptions: {
            implicitRefs: [
              {
                path: './packages/pkg/tsconfig.json',
                reason: 'Aggregators do not own source files.',
              },
            ],
          },
          references: [
            {
              path: './packages/pkg/tsconfig.json',
            },
          ],
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores inert shared graph root build configs', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'tsconfig.custom.build.json': JSON.stringify({
          files: [],
          references: [
            {
              path: './packages/pkg/tsconfig.lib.dts.json',
            },
          ],
        }),
        'tsconfig.build.json': JSON.stringify({
          files: [],
          references: [],
        }),
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            checkers: {
              typescript: {
                include: ['packages/pkg/tsconfig.json'],
                preset: 'tsc',
              },
            },
          },
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts a direct graph-capable checker entry', async () => {
    const fixture = await createFixture(createPassingFiles());

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            checkers: {
              typescript: {
                preset: 'tsc',
                include: ['packages/pkg/tsconfig.json'],
              },
            },
          },
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });
});
