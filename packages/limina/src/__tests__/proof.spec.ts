import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runProofCheck } from '../commands/proof';
import type { ResolvedLiminaConfig } from '../config';
import { ProofLogger } from '../logger';

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

async function createFixture(files: Record<string, string>): Promise<{
  cleanup: () => Promise<void>;
  config: ResolvedLiminaConfig;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-proof-')),
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
        checkers: {
          typescript: {
            preset: 'tsc',
            entry: 'tsconfig.build.json',
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
    'packages/pkg/tsconfig.lib.dts.json': JSON.stringify({
      extends: './tsconfig.json',
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
    'tsconfig.build.json': JSON.stringify({
      files: [],
      references: [
        {
          path: './packages/pkg/tsconfig.lib.dts.json',
        },
      ],
    }),
    ...overrides,
  };
}

function createStrictSingleEnvironmentFiles(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    'packages/pkg/src/index.ts': 'export const value = 1;\n',
    'packages/pkg/tsconfig.dts.json': JSON.stringify({
      extends: './tsconfig.json',
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
    'tsconfig.build.json': JSON.stringify({
      files: [],
      references: [
        {
          path: './packages/pkg/tsconfig.dts.json',
        },
      ],
    }),
    ...overrides,
  };
}

function createStrictMultiEnvironmentFiles(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return createPassingFiles({
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

describe('runProofCheck dts config semantics', () => {
  it('accepts a single-environment dts leaf paired with default tsconfig.json', async () => {
    const fixture = await createFixture(createPassingFiles());

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('gates missing typecheck declaration companions behind strict mode', async () => {
    const fixture = await createFixture(createStrictMultiEnvironmentFiles());

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
      await expect(
        runProofCheck({
          ...fixture.config,
          strict: true,
        }),
      ).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects dts leaves that do not transitively extend their companion in strict mode', async () => {
    const fixture = await createFixture(
      createStrictSingleEnvironmentFiles({
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
      await expect(
        runProofCheck({
          ...fixture.config,
          strict: true,
        }),
      ).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts dts leaves that transitively extend their companion in strict mode', async () => {
    const fixture = await createFixture(
      createStrictSingleEnvironmentFiles({
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
      await expect(
        runProofCheck({
          ...fixture.config,
          strict: true,
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects build graph references to ordinary configs in strict mode', async () => {
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
      await expect(
        runProofCheck({
          ...fixture.config,
          strict: true,
        }),
      ).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects duplicate ordinary typecheck ownership in strict mode', async () => {
    const fixture = await createFixture(createStrictMultiEnvironmentFiles());

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
      await expect(
        runProofCheck({
          ...fixture.config,
          strict: true,
        }),
      ).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects build graph aggregators with source inputs or compilerOptions', async () => {
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
      await expect(runProofCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects dts leaves without declaration emit semantics', async () => {
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
      await expect(runProofCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects multi-environment directories without a default aggregator', async () => {
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
      await expect(runProofCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects default tsconfig aggregators with source or compiler settings', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'tsconfig.json': JSON.stringify({
          extends: './tsconfig.base.json',
          compilerOptions: {
            noEmit: true,
          },
          files: [],
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
      await expect(runProofCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports missing strict local tsconfig files', async () => {
    const files = createPassingFiles();
    delete files['packages/pkg/tsconfig.json'];
    const fixture = await createFixture(files);

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports typecheck compiler option drift from the strict local tsconfig', async () => {
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
      await expect(runProofCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts declaration-only compiler option extensions', async () => {
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

  it('reports dts and local file set drift', async () => {
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
      await expect(runProofCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores paths and baseUrl drift because module resolution is checked by graph validation', async () => {
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

  it('reports duplicate same-family checker build owners', async () => {
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
                entry: 'tsconfig.build.json',
              },
              secondary: {
                preset: 'tsc',
                entry: 'tsconfig.alt.build.json',
              },
            },
          },
        }),
      ).resolves.toBe(false);
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
              ...fixture.config.config?.checkers,
              vue: {
                entry: 'packages/pkg/tsconfig.sfc.dts.json',
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

  it('reports missing configured checker entry configs', async () => {
    const fixture = await createFixture(createPassingFiles());

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            checkers: {
              ...fixture.config.config?.checkers,
              vue: {
                entry: 'packages/pkg/tsconfig.missing.dts.json',
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

  it('reports source files outside checker entries and allowlist coverage', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/fixtures/uncovered.ts': 'export const uncovered = 1;\n',
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(false);
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
        'tools/tsconfig.dts.json': JSON.stringify({
          extends: './tsconfig.json',
          compilerOptions: {
            composite: true,
            declaration: true,
            emitDeclarationOnly: true,
            noEmit: false,
            outDir: './.tsbuild',
            rootDir: '.',
            tsBuildInfoFile: './.tsbuild/tools.tsbuildinfo',
          },
        }),
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
        'tsconfig.build.json': JSON.stringify({
          files: [],
          references: [
            {
              path: './packages/pkg/tsconfig.lib.dts.json',
            },
            {
              path: './tools/tsconfig.dts.json',
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

  it('accepts JavaScript config files handled by an active preset', async () => {
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
      ).resolves.toBe(true);
    } finally {
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
        'tools/tsconfig.dts.json': JSON.stringify({
          extends: './tsconfig.json',
          compilerOptions: {
            composite: true,
            declaration: true,
            emitDeclarationOnly: true,
            noEmit: false,
            outDir: './.tsbuild',
            tsBuildInfoFile: './.tsbuild/build.tsbuildinfo',
          },
        }),
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
              ...fixture.config.config?.checkers,
              vue: {
                entry: 'tools/tsconfig.dts.json',
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

  it('accepts TypeScript source covered by a vue-tsgo checker entry', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'tools/covered.vue':
          '<script setup lang="ts">import "./helper";</script>\n',
        'tools/helper.ts': 'export const helper = 1;\n',
        'tools/widget.tsx': 'export const widget = <div />;\n',
        'tools/tsconfig.dts.json': JSON.stringify({
          extends: './tsconfig.json',
          compilerOptions: {
            composite: true,
            declaration: true,
            emitDeclarationOnly: true,
            noEmit: false,
            outDir: './.tsbuild',
            tsBuildInfoFile: './.tsbuild/build.tsbuildinfo',
          },
        }),
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
              ...fixture.config.config?.checkers,
              vue: {
                entry: 'tools/tsconfig.dts.json',
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

  it('uses the shared graph root config', async () => {
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
                preset: 'tsc',
                entry: 'tsconfig.custom.build.json',
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
                entry: 'packages/pkg/tsconfig.lib.dts.json',
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
