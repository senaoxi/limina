import type { CheckerPackageResolver } from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  runBuild as runBuildCommand,
  type RunBuildOptions,
  runCheckerBuild as runCheckerBuildCommand,
  type RunCheckerBuildOptions,
  runCheckerTypecheck as runCheckerTypecheckCommand,
  type RunCheckerTypecheckOptions,
} from '../commands/typecheck';
import { TypecheckLogger } from '../logger';
import type {
  TypecheckRunner,
  TypecheckTarget,
  TypecheckTargetResult,
} from '../typecheck/targets';
import { toPortablePath } from './helpers/path';

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

async function createFixture(files: Record<string, string>): Promise<{
  cleanup: () => Promise<void>;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-typecheck-')),
  );
  const fixtureFiles = {
    'package.json': `${JSON.stringify(
      {
        name: 'root',
        private: true,
      },
      null,
      2,
    )}\n`,
    'pnpm-workspace.yaml': 'packages:\n  - app\n  - packages/*\n',
    ...files,
  };

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
    rootDir,
  };
}

function tsconfig(value: unknown): string {
  return JSON.stringify(value);
}

const installedCheckerPackageResolver: CheckerPackageResolver = ({
  packageName,
}) => packageName;

function runCheckerBuild(options: RunCheckerBuildOptions) {
  return runCheckerBuildCommand({
    checkerPackageResolver: installedCheckerPackageResolver,
    ...options,
  });
}

function runBuild(options: RunBuildOptions) {
  return runBuildCommand({
    checkerPackageResolver: installedCheckerPackageResolver,
    ...options,
  });
}

function runCheckerTypecheck(options: RunCheckerTypecheckOptions) {
  return runCheckerTypecheckCommand({
    checkerPackageResolver: installedCheckerPackageResolver,
    ...options,
  });
}

function passingRunner(calls: TypecheckTarget[] = []) {
  return async (target: TypecheckTarget): Promise<TypecheckTargetResult> => {
    calls.push(target);

    return {
      configPath: target.configPath,
      status: 0,
    };
  };
}

function failingRunner(calls: TypecheckTarget[] = []) {
  return async (target: TypecheckTarget): Promise<TypecheckTargetResult> => {
    calls.push(target);

    return {
      configPath: target.configPath,
      status: 1,
    };
  };
}

function getExpectedDefaultBuildConcurrency(targetCount: number): number {
  return Math.min(targetCount, availableParallelism() ?? 4);
}

function delayedRunner(options: {
  calls: TypecheckTarget[];
  delayMs?: (target: TypecheckTarget) => number;
  status?: number;
}): {
  getMaxActive: () => number;
  runner: TypecheckRunner;
} {
  let activeCount = 0;
  let maxActiveCount = 0;

  return {
    getMaxActive: () => maxActiveCount,
    runner: async (target): Promise<TypecheckTargetResult> => {
      options.calls.push(target);
      activeCount += 1;
      maxActiveCount = Math.max(maxActiveCount, activeCount);

      await new Promise((resolve) => {
        setTimeout(resolve, options.delayMs?.(target) ?? 10);
      });

      activeCount -= 1;

      return {
        configPath: target.configPath,
        status: options.status ?? 0,
      };
    },
  };
}

function createLiminaConfig(rootDir: string): ResolvedLiminaConfig {
  return {
    config: {
      checkers: {
        svelte: {
          include: ['svelte/tsconfig.json'],
          preset: 'svelte-check',
        },
        typescript: {
          include: ['tsconfig.json'],
          preset: 'tsc',
        },
        vue: {
          include: ['vue/tsconfig.json'],
          preset: 'vue-tsc',
        },
      },
    },
    configPath: path.join(rootDir, 'limina.config.mjs'),
    rootDir,
  };
}

describe('runCheckerBuild', () => {
  it('runs only first-class build checker entries', async () => {
    const calls: TypecheckTarget[] = [];
    const fixture = await createFixture({
      'tsconfig.build.json': tsconfig({ files: [] }),
      'tsconfig.svelte.build.json': tsconfig({ files: [] }),
      'tsconfig.vue.build.json': tsconfig({ files: [] }),
    });

    try {
      const result = await runCheckerBuild({
        config: createLiminaConfig(fixture.rootDir),
        cwd: fixture.rootDir,
        runner: passingRunner(calls),
      });

      expect(result.passed).toBe(true);
      expect(calls.map((target) => target.command)).toEqual(['tsc', 'vue-tsc']);
      expect(calls.map((target) => target.args)).toEqual([
        [
          '-b',
          '.limina/tsconfig/checkers/typescript/tsconfig.build.json',
          '--pretty',
          'false',
        ],
        [
          '-b',
          '.limina/tsconfig/checkers/vue/tsconfig.build.json',
          '--pretty',
          'false',
        ],
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('runs first-class build checker entries with default concurrency', async () => {
    const calls: TypecheckTarget[] = [];
    const delayed = delayedRunner({
      calls,
      delayMs: (target) => (target.command === 'tsc' ? 30 : 10),
    });
    const fixture = await createFixture({
      'tsconfig.build.json': tsconfig({ files: [] }),
      'tsconfig.vue.build.json': tsconfig({ files: [] }),
    });

    try {
      const result = await runCheckerBuild({
        config: {
          config: {
            checkers: {
              typescript: {
                include: ['tsconfig.json'],
                preset: 'tsc',
              },
              vue: {
                include: ['vue/tsconfig.json'],
                preset: 'vue-tsc',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        cwd: fixture.rootDir,
        runner: delayed.runner,
      });

      expect(result.passed).toBe(true);
      expect(calls.map((target) => target.command)).toEqual(['tsc', 'vue-tsc']);
      expect(delayed.getMaxActive()).toBe(
        getExpectedDefaultBuildConcurrency(2),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('runs cyclic cross-checker provider entries in the same build layer', async () => {
    const calls: TypecheckTarget[] = [];
    const delayed = delayedRunner({
      calls,
      delayMs: () => 30,
    });
    const fixture = await createFixture({
      'packages/app/src/index.ts':
        "import { themeValue } from '../../theme/src/index';\nexport const appValue = themeValue;\n",
      'packages/app/tsconfig.json': tsconfig({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/theme/src/index.ts':
        "import { appValue } from '../../app/src/index';\nexport const themeValue = appValue;\n",
      'packages/theme/tsconfig.json': tsconfig({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await runCheckerBuild({
        config: {
          config: {
            checkers: {
              typescript: {
                include: ['packages/app/tsconfig.json'],
                preset: 'tsc',
              },
              themeTypescript: {
                include: ['packages/theme/tsconfig.json'],
                preset: 'tsc',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        cwd: fixture.rootDir,
        runner: delayed.runner,
      });

      expect(result.passed).toBe(true);
      expect(calls.map((target) => target.command)).toEqual(['tsc', 'tsc']);
      expect(delayed.getMaxActive()).toBe(
        getExpectedDefaultBuildConcurrency(2),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not warn when incompatible presets build separate generated dts configs for the same source config', async () => {
    const calls: TypecheckTarget[] = [];
    const warnSpy = vi
      .spyOn(TypecheckLogger, 'warn')
      .mockImplementation(() => {});
    const fixture = await createFixture({
      'packages/native/tsconfig.json': tsconfig({
        files: [],
        references: [
          {
            path: '../shared/tsconfig.lib.json',
          },
        ],
      }),
      'packages/shared/src/index.ts': 'export const value = 1;\n',
      'packages/shared/tsconfig.lib.json': tsconfig({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/vue/tsconfig.json': tsconfig({
        files: [],
        references: [
          {
            path: '../shared/tsconfig.lib.json',
          },
        ],
      }),
    });

    try {
      const result = await runCheckerBuild({
        config: {
          config: {
            checkers: {
              nativeTypescript: {
                include: ['packages/native/tsconfig.json'],
                preset: 'tsgo',
              },
              vue: {
                include: ['packages/vue/tsconfig.json'],
                preset: 'vue-tsc',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        cwd: fixture.rootDir,
        runner: passingRunner(calls),
      });

      expect(result.passed).toBe(true);
      expect(calls.map((target) => target.command)).toEqual([
        'tsgo',
        'vue-tsc',
      ]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('rejects incompatible cross-engine provider traversal before checker build', async () => {
    const calls: TypecheckTarget[] = [];
    const warnSpy = vi
      .spyOn(TypecheckLogger, 'warn')
      .mockImplementation(() => {});
    const fixture = await createFixture({
      'packages/shared/src/index.ts': 'export const sharedValue = 1;\n',
      'packages/shared/tsconfig.json': tsconfig({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/theme/src/index.ts':
        "import { sharedValue } from '../../shared/src/index';\nexport const themeValue = sharedValue;\n",
      'packages/theme/tsconfig.json': tsconfig({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      await expect(
        runCheckerBuild({
          config: {
            config: {
              checkers: {
                nativeTypescript: {
                  include: ['packages/shared/tsconfig.json'],
                  preset: 'tsgo',
                },
                vue: {
                  include: ['packages/theme/tsconfig.json'],
                  preset: 'vue-tsc',
                },
              },
            },
            configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
            rootDir: fixture.rootDir,
          },
          cwd: fixture.rootDir,
          runner: passingRunner(calls),
        }),
      ).rejects.toThrow('Unsafe cross-engine declaration provider');
      expect(calls).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('runs tsgo checker entries with build mode', async () => {
    const calls: TypecheckTarget[] = [];
    const fixture = await createFixture({
      'tsconfig.build.json': tsconfig({ files: [] }),
    });

    try {
      const result = await runCheckerBuild({
        config: {
          config: {
            checkers: {
              nativeTypescript: {
                include: ['tsconfig.json'],
                preset: 'tsgo',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        cwd: fixture.rootDir,
        runner: passingRunner(calls),
      });

      expect(result.passed).toBe(true);
      expect(calls.map((target) => target.command)).toEqual(['tsgo']);
      expect(calls.map((target) => target.args)).toEqual([
        [
          '-b',
          '.limina/tsconfig/checkers/nativeTypescript/tsconfig.build.json',
          '--pretty',
          'false',
        ],
      ]);
      expect(calls.map((target) => target.label)).toEqual([
        'tsgo -b .limina/tsconfig/checkers/nativeTypescript/tsconfig.build.json',
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not run vue-tsgo checker entries in build mode', async () => {
    const calls: TypecheckTarget[] = [];
    const fixture = await createFixture({
      'tsconfig.vue.build.json': tsconfig({ files: [] }),
    });

    try {
      const result = await runCheckerBuild({
        config: {
          config: {
            checkers: {
              vue: {
                include: ['vue/tsconfig.json'],
                preset: 'vue-tsgo',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        cwd: fixture.rootDir,
        runner: passingRunner(calls),
      });

      expect(result.passed).toBe(true);
      expect(calls).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not require the Vue SFC compiler for vue-tsc by default', async () => {
    const calls: TypecheckTarget[] = [];
    const errorSpy = vi
      .spyOn(TypecheckLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture({
      'tsconfig.build.json': tsconfig({ files: [] }),
      'tsconfig.vue.build.json': tsconfig({ files: [] }),
    });

    try {
      const result = await runCheckerBuild({
        checkerPackageResolver: ({ packageName }) =>
          packageName === 'typescript' || packageName === 'vue-tsc'
            ? packageName
            : undefined,
        config: {
          config: {
            checkers: {
              typescript: {
                include: ['tsconfig.json'],
                preset: 'tsc',
              },
              vue: {
                include: ['vue/tsconfig.json'],
                preset: 'vue-tsc',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        cwd: fixture.rootDir,
        runner: passingRunner(calls),
      });

      expect(result.passed).toBe(true);
      expect(calls.map((target) => target.command)).toEqual(['tsc', 'vue-tsc']);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('requires the Vue SFC compiler when compiler-sfc import analysis is enabled', async () => {
    const calls: TypecheckTarget[] = [];
    const errorSpy = vi
      .spyOn(TypecheckLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture({
      'tsconfig.build.json': tsconfig({ files: [] }),
      'tsconfig.vue.build.json': tsconfig({ files: [] }),
    });

    try {
      const result = await runCheckerBuild({
        checkerPackageResolver: ({ packageName }) =>
          packageName === 'typescript' || packageName === 'vue-tsc'
            ? packageName
            : undefined,
        config: {
          config: {
            checkers: {
              typescript: {
                include: ['tsconfig.json'],
                preset: 'tsc',
              },
              vue: {
                include: ['vue/tsconfig.json'],
                preset: 'vue-tsc',
              },
            },
            imports: {
              vue: 'compiler-sfc',
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        cwd: fixture.rootDir,
        runner: passingRunner(calls),
      });

      expect(result.passed).toBe(false);
      expect(calls).toHaveLength(0);
      expect(errorSpy.mock.calls.join('\n')).toContain('@vue/compiler-sfc');
      expect(errorSpy.mock.calls.join('\n')).toContain('config.imports.vue');
      expect(errorSpy.mock.calls.join('\n')).toContain('"compiler-sfc"');
      expect(errorSpy.mock.calls.join('\n')).toContain(
        'Fix: pnpm add -D @vue/compiler-sfc',
      );
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('requires the native preview package for tsgo entries', async () => {
    const calls: TypecheckTarget[] = [];
    const errorSpy = vi
      .spyOn(TypecheckLogger, 'error')
      .mockImplementation(() => {});
    const warnSpy = vi
      .spyOn(TypecheckLogger, 'warn')
      .mockImplementation(() => {});
    const fixture = await createFixture({
      'tsconfig.build.json': tsconfig({ files: [] }),
    });

    try {
      const result = await runCheckerBuild({
        checkerPackageResolver: (): string | undefined => undefined,
        config: {
          config: {
            checkers: {
              nativeTypescript: {
                include: ['tsconfig.json'],
                preset: 'tsgo',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        cwd: fixture.rootDir,
        runner: passingRunner(calls),
      });

      expect(result.passed).toBe(false);
      expect(calls).toHaveLength(0);
      expect(errorSpy.mock.calls.join('\n')).toContain(
        '@typescript/native-preview',
      );
      expect(errorSpy.mock.calls.join('\n')).toContain(
        'Fix: pnpm add -D @typescript/native-preview',
      );
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('reports failed build checker entries', async () => {
    const calls: TypecheckTarget[] = [];
    const fixture = await createFixture({
      'tsconfig.build.json': tsconfig({ files: [] }),
      'tsconfig.svelte.build.json': tsconfig({ files: [] }),
      'tsconfig.vue.build.json': tsconfig({ files: [] }),
    });

    try {
      const result = await runCheckerBuild({
        config: createLiminaConfig(fixture.rootDir),
        cwd: fixture.rootDir,
        runner: failingRunner(calls),
      });

      expect(result.passed).toBe(false);
      expect(calls).toHaveLength(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports concurrent build checker failures in target order', async () => {
    const calls: TypecheckTarget[] = [];
    const errorSpy = vi
      .spyOn(TypecheckLogger, 'error')
      .mockImplementation(() => {});
    const delayed = delayedRunner({
      calls,
      delayMs: (target) => (target.command === 'tsc' ? 30 : 10),
      status: 1,
    });
    const fixture = await createFixture({
      'tsconfig.build.json': tsconfig({ files: [] }),
      'tsconfig.vue.build.json': tsconfig({ files: [] }),
    });

    try {
      const result = await runCheckerBuild({
        config: {
          config: {
            checkers: {
              typescript: {
                include: ['tsconfig.json'],
                preset: 'tsc',
              },
              vue: {
                include: ['vue/tsconfig.json'],
                preset: 'vue-tsc',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        cwd: fixture.rootDir,
        runner: delayed.runner,
      });
      const errorText = errorSpy.mock.calls
        .map(([message]) => String(message))
        .join('\n');
      const typescriptPath =
        '.limina/tsconfig/checkers/typescript/tsconfig.build.json';
      const vuePath = '.limina/tsconfig/checkers/vue/tsconfig.build.json';

      expect(result.passed).toBe(false);
      expect(calls.map((target) => target.command)).toEqual(['tsc', 'vue-tsc']);
      expect(delayed.getMaxActive()).toBe(
        getExpectedDefaultBuildConcurrency(2),
      );
      expect(errorText.indexOf(typescriptPath)).toBeGreaterThanOrEqual(0);
      expect(errorText.indexOf(typescriptPath)).toBeLessThan(
        errorText.indexOf(vuePath),
      );
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('does not copy declaration inputs for internal checker builds', async () => {
    const calls: TypecheckTarget[] = [];
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/src/vite-env.d.ts':
        '/// <reference types="vite/client" />\n',
      'packages/pkg/tsconfig.json': tsconfig({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
      'packages/pkg/tsconfig.lib.json': tsconfig({
        liminaOptions: {
          outputs: {
            outDir: './dist',
            rootDir: './src',
          },
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*'],
      }),
    });

    try {
      const result = await runCheckerBuild({
        config: {
          config: {
            checkers: {
              typescript: {
                include: ['packages/pkg/tsconfig.json'],
                preset: 'tsc',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        configPath: 'packages/pkg/tsconfig.lib.json',
        cwd: fixture.rootDir,
        runner: passingRunner(calls),
      });

      expect(result.passed).toBe(true);
      expect(
        existsSync(
          path.join(fixture.rootDir, 'packages/pkg/dist/vite-env.d.ts'),
        ),
      ).toBe(false);
      expect(calls.map((target) => target.args)).toEqual([
        [
          '-b',
          '.limina/tsconfig/checkers/typescript/projects/packages/pkg/tsconfig.lib.dts.json',
          '--pretty',
          'false',
        ],
      ]);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('runBuild', () => {
  it('builds the nearest solution tsconfig from cwd', async () => {
    const calls: TypecheckTarget[] = [];
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.json': tsconfig({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
      'packages/pkg/tsconfig.lib.json': tsconfig({
        liminaOptions: {
          outputs: {},
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await runBuild({
        config: {
          config: {
            checkers: {
              typescript: {
                include: ['packages/pkg/tsconfig.json'],
                preset: 'tsc',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        cwd: path.join(fixture.rootDir, 'packages/pkg/src'),
        runner: passingRunner(calls),
      });

      expect(result.passed).toBe(true);
      expect(toPortablePath(result.sourceConfigPath ?? '')).toBe(
        toPortablePath(
          path.join(fixture.rootDir, 'packages/pkg/tsconfig.json'),
        ),
      );
      expect(calls.map((target) => target.args)).toEqual([
        [
          '-b',
          '.limina/tsconfig/checkers/typescript/outputs/solutions/packages/pkg/tsconfig.output.json',
          '--pretty',
          'false',
        ],
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('builds a selected source leaf from an explicit config path', async () => {
    const calls: TypecheckTarget[] = [];
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.json': tsconfig({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
      'packages/pkg/tsconfig.lib.json': tsconfig({
        liminaOptions: {
          outputs: {},
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await runBuild({
        config: {
          config: {
            checkers: {
              typescript: {
                include: ['packages/pkg/tsconfig.json'],
                preset: 'tsc',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        cwd: fixture.rootDir,
        configPath: 'packages/pkg/tsconfig.lib.json',
        runner: passingRunner(calls),
      });

      expect(result.passed).toBe(true);
      expect(calls.map((target) => target.args)).toEqual([
        [
          '-b',
          '.limina/tsconfig/checkers/typescript/outputs/projects/packages/pkg/tsconfig.lib.output.json',
          '--pretty',
          'false',
        ],
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('copies local declaration inputs after managed output build', async () => {
    const calls: TypecheckTarget[] = [];
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/src/vite-env.d.ts':
        '/// <reference types="vite/client" />\n',
      'packages/pkg/tsconfig.json': tsconfig({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
      'packages/pkg/tsconfig.lib.json': tsconfig({
        liminaOptions: {
          outputs: {
            outDir: './dist',
            rootDir: './src',
          },
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts', 'src/**/*.d.ts'],
      }),
    });

    try {
      const result = await runBuild({
        config: {
          config: {
            checkers: {
              typescript: {
                include: ['packages/pkg/tsconfig.json'],
                preset: 'tsc',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        configPath: 'packages/pkg/tsconfig.lib.json',
        cwd: fixture.rootDir,
        runner: passingRunner(calls),
      });

      expect(result.passed).toBe(true);
      await expect(
        readFile(
          path.join(fixture.rootDir, 'packages/pkg/dist/vite-env.d.ts'),
          'utf8',
        ),
      ).resolves.toBe('/// <reference types="vite/client" />\n');
    } finally {
      await fixture.cleanup();
    }
  });

  it('copies .d.mts and .d.cts declaration inputs after managed output build', async () => {
    const calls: TypecheckTarget[] = [];
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/src/runtime.d.mts': 'declare const esmValue: 1;\n',
      'packages/pkg/src/runtime.d.cts': 'declare const cjsValue: 1;\n',
      'packages/pkg/tsconfig.json': tsconfig({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
      'packages/pkg/tsconfig.lib.json': tsconfig({
        liminaOptions: {
          outputs: {
            outDir: './dist',
            rootDir: './src',
          },
        },
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*'],
      }),
    });

    try {
      const result = await runBuild({
        config: {
          config: {
            checkers: {
              typescript: {
                include: ['packages/pkg/tsconfig.json'],
                preset: 'tsc',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        configPath: 'packages/pkg/tsconfig.lib.json',
        cwd: fixture.rootDir,
        runner: passingRunner(calls),
      });

      expect(result.passed).toBe(true);
      await expect(
        readFile(
          path.join(fixture.rootDir, 'packages/pkg/dist/runtime.d.mts'),
          'utf8',
        ),
      ).resolves.toBe('declare const esmValue: 1;\n');
      await expect(
        readFile(
          path.join(fixture.rootDir, 'packages/pkg/dist/runtime.d.cts'),
          'utf8',
        ),
      ).resolves.toBe('declare const cjsValue: 1;\n');
    } finally {
      await fixture.cleanup();
    }
  });

  it('surfaces warnings for outside-root local declaration inputs', async () => {
    const calls: TypecheckTarget[] = [];
    const warnSpy = vi
      .spyOn(TypecheckLogger, 'warn')
      .mockImplementation(() => {});
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/types/client.d.ts': 'declare const clientValue: 1;\n',
      'packages/pkg/tsconfig.json': tsconfig({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
      'packages/pkg/tsconfig.lib.json': tsconfig({
        files: ['src/index.ts', 'types/client.d.ts'],
        liminaOptions: {
          outputs: {
            outDir: './dist',
            rootDir: './src',
          },
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
      }),
    });

    try {
      const result = await runBuild({
        config: {
          config: {
            checkers: {
              typescript: {
                include: ['packages/pkg/tsconfig.json'],
                preset: 'tsc',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        configPath: 'packages/pkg/tsconfig.lib.json',
        cwd: fixture.rootDir,
        runner: passingRunner(calls),
      });

      expect(result.passed).toBe(true);
      expect(warnSpy.mock.calls.join('\n')).toContain(
        'Output declaration inputs outside rootDir were not copied',
      );
      expect(warnSpy.mock.calls.join('\n')).toContain(
        'packages/pkg/types/client.d.ts',
      );
    } finally {
      warnSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('does not copy rootDir-external or node_modules declaration inputs', async () => {
    const calls: TypecheckTarget[] = [];
    const warnSpy = vi
      .spyOn(TypecheckLogger, 'warn')
      .mockImplementation(() => {});
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/types/client.d.ts': 'declare const clientValue: 1;\n',
      'packages/pkg/node_modules/pkg/client.d.ts':
        'declare const dependencyValue: 1;\n',
      'packages/pkg/tsconfig.json': tsconfig({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
      'packages/pkg/tsconfig.lib.json': tsconfig({
        files: [
          'src/index.ts',
          'types/client.d.ts',
          'node_modules/pkg/client.d.ts',
        ],
        liminaOptions: {
          outputs: {
            outDir: './dist',
            rootDir: './src',
          },
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
      }),
    });

    try {
      const result = await runBuild({
        config: {
          config: {
            checkers: {
              typescript: {
                include: ['packages/pkg/tsconfig.json'],
                preset: 'tsc',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        configPath: 'packages/pkg/tsconfig.lib.json',
        cwd: fixture.rootDir,
        runner: passingRunner(calls),
      });

      expect(result.passed).toBe(true);
      expect(
        existsSync(path.join(fixture.rootDir, 'packages/pkg/dist/client.d.ts')),
      ).toBe(false);
      expect(warnSpy.mock.calls.join('\n')).toContain(
        'packages/pkg/types/client.d.ts',
      );
      expect(warnSpy.mock.calls.join('\n')).not.toContain(
        'node_modules/pkg/client.d.ts',
      );
    } finally {
      warnSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('fails managed output build when declaration copy conflicts with existing output', async () => {
    const calls: TypecheckTarget[] = [];
    const errorSpy = vi
      .spyOn(TypecheckLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture({
      'packages/pkg/src/foo.ts': 'export const value = 1;\n',
      'packages/pkg/src/foo.d.ts': 'declare const sourceValue: 1;\n',
      'packages/pkg/dist/foo.d.ts': 'declare const emittedValue: 1;\n',
      'packages/pkg/tsconfig.json': tsconfig({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
      'packages/pkg/tsconfig.lib.json': tsconfig({
        liminaOptions: {
          outputs: {
            outDir: './dist',
            rootDir: './src',
          },
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        files: ['src/foo.ts', 'src/foo.d.ts'],
      }),
    });

    try {
      const result = await runBuild({
        config: {
          config: {
            checkers: {
              typescript: {
                include: ['packages/pkg/tsconfig.json'],
                preset: 'tsc',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        configPath: 'packages/pkg/tsconfig.lib.json',
        cwd: fixture.rootDir,
        runner: passingRunner(calls),
      });

      expect(result.passed).toBe(false);
      expect(result.failureKind).toBe('process');
      expect(result.problems?.join('\n')).toContain(
        'Output declaration copy conflict',
      );
      expect(errorSpy.mock.calls.join('\n')).toContain(
        'Output declaration copy conflict',
      );
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('copies declaration inputs for all output leaves in a solution build', async () => {
    const calls: TypecheckTarget[] = [];
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/src/lib-env.d.ts': 'declare const libEnv: 1;\n',
      'packages/pkg/test/index.ts': 'export const testValue = 1;\n',
      'packages/pkg/test/test-env.d.ts': 'declare const testEnv: 1;\n',
      'packages/pkg/tsconfig.json': tsconfig({
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
      'packages/pkg/tsconfig.lib.json': tsconfig({
        liminaOptions: {
          outputs: {
            outDir: './dist/lib',
            rootDir: './src',
          },
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*'],
      }),
      'packages/pkg/tsconfig.test.json': tsconfig({
        liminaOptions: {
          outputs: {
            outDir: './dist/test',
            rootDir: './test',
          },
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['test/**/*'],
      }),
    });

    try {
      const result = await runBuild({
        config: {
          config: {
            checkers: {
              typescript: {
                include: ['packages/pkg/tsconfig.json'],
                preset: 'tsc',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        configPath: 'packages/pkg/tsconfig.json',
        cwd: fixture.rootDir,
        runner: passingRunner(calls),
      });

      expect(result.passed).toBe(true);
      await expect(
        readFile(
          path.join(fixture.rootDir, 'packages/pkg/dist/lib/lib-env.d.ts'),
          'utf8',
        ),
      ).resolves.toBe('declare const libEnv: 1;\n');
      await expect(
        readFile(
          path.join(fixture.rootDir, 'packages/pkg/dist/test/test-env.d.ts'),
          'utf8',
        ),
      ).resolves.toBe('declare const testEnv: 1;\n');
    } finally {
      await fixture.cleanup();
    }
  });

  it('skips declaration input copying in watch mode', async () => {
    const calls: TypecheckTarget[] = [];
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/src/vite-env.d.ts':
        '/// <reference types="vite/client" />\n',
      'packages/pkg/tsconfig.json': tsconfig({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
        ],
      }),
      'packages/pkg/tsconfig.lib.json': tsconfig({
        liminaOptions: {
          outputs: {
            outDir: './dist',
            rootDir: './src',
          },
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*'],
      }),
    });

    try {
      const result = await runBuild({
        config: {
          config: {
            checkers: {
              typescript: {
                include: ['packages/pkg/tsconfig.json'],
                preset: 'tsc',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        configPath: 'packages/pkg/tsconfig.lib.json',
        cwd: fixture.rootDir,
        runner: passingRunner(calls),
        watch: true,
      });

      expect(result.passed).toBe(true);
      expect(
        existsSync(
          path.join(fixture.rootDir, 'packages/pkg/dist/vite-env.d.ts'),
        ),
      ).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('raw builds selected configs that are not governed by a checker', async () => {
    const calls: TypecheckTarget[] = [];
    const fixture = await createFixture({
      'packages/app/src/index.ts': 'export const value = 1;\n',
      'packages/app/tsconfig.json': tsconfig({
        liminaOptions: {
          outputs: {},
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/lib/src/index.ts': 'export const value = 1;\n',
      'packages/lib/tsconfig.json': tsconfig({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await runBuild({
        checker: 'tsc',
        config: {
          config: {
            checkers: {
              typescript: {
                include: ['packages/app/tsconfig.json'],
                preset: 'tsc',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        cwd: fixture.rootDir,
        configPath: 'packages/lib/tsconfig.json',
        raw: true,
        runner: passingRunner(calls),
      });

      expect(result.passed).toBe(true);
      expect(calls.map((target) => target.command)).toEqual(['tsc']);
      expect(calls.map((target) => target.args)).toEqual([
        ['-b', 'packages/lib/tsconfig.json', '--pretty', 'false'],
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('passes watch mode to raw build targets', async () => {
    const calls: TypecheckTarget[] = [];
    const fixture = await createFixture({
      'packages/app/src/index.ts': 'export const value = 1;\n',
      'packages/app/tsconfig.raw.json': tsconfig({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/managed/src/index.ts': 'export const value = 1;\n',
      'packages/managed/tsconfig.json': tsconfig({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await runBuild({
        checker: 'tsc',
        config: {
          config: {
            checkers: {
              typescript: {
                include: ['packages/managed/tsconfig.json'],
                preset: 'tsc',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        cwd: fixture.rootDir,
        configPath: 'packages/app/tsconfig.raw.json',
        raw: true,
        runner: passingRunner(calls),
        watch: true,
      });

      expect(result.passed).toBe(true);
      expect(calls.map((target) => target.args)).toEqual([
        [
          '-b',
          'packages/app/tsconfig.raw.json',
          '--pretty',
          'false',
          '--watch',
          '--preserveWatchOutput',
        ],
      ]);
      expect(calls.map((target) => target.label)).toEqual([
        'tsc -b packages/app/tsconfig.raw.json --watch',
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('raw builds selected configs with the requested checker', async () => {
    const calls: TypecheckTarget[] = [];
    const fixture = await createFixture({
      'packages/app/src/index.vue': '<script setup lang="ts"></script>\n',
      'packages/app/tsconfig.raw.json': tsconfig({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.vue'],
      }),
      'packages/managed/src/index.ts': 'export const value = 1;\n',
      'packages/managed/tsconfig.json': tsconfig({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await runBuild({
        checker: 'vue-tsc',
        config: {
          config: {
            checkers: {
              typescript: {
                include: ['packages/managed/tsconfig.json'],
                preset: 'tsc',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        cwd: fixture.rootDir,
        configPath: 'packages/app/tsconfig.raw.json',
        raw: true,
        runner: passingRunner(calls),
      });

      expect(result.passed).toBe(true);
      expect(calls.map((target) => target.command)).toEqual(['vue-tsc']);
      expect(calls.map((target) => target.args)).toEqual([
        ['-b', 'packages/app/tsconfig.raw.json', '--pretty', 'false'],
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects raw builds for generated .limina configs', async () => {
    const fixture = await createFixture({
      '.limina/tsconfig/generated.json': tsconfig({
        include: [],
      }),
      'packages/managed/src/index.ts': 'export const value = 1;\n',
      'packages/managed/tsconfig.json': tsconfig({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      await expect(
        runBuild({
          checker: 'tsc',
          config: {
            config: {
              checkers: {
                typescript: {
                  include: ['packages/managed/tsconfig.json'],
                  preset: 'tsc',
                },
              },
            },
            configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
            rootDir: fixture.rootDir,
          },
          configPath: '.limina/tsconfig/generated.json',
          cwd: fixture.rootDir,
          raw: true,
          runner: passingRunner(),
        }),
      ).rejects.toThrow('.limina generated configs');
    } finally {
      await fixture.cleanup();
    }
  });

  it('raw build ignores liminaOptions.outputs validation', async () => {
    const calls: TypecheckTarget[] = [];
    const fixture = await createFixture({
      'packages/app/src/index.ts': 'export const value = 1;\n',
      'packages/app/tsconfig.raw.json': tsconfig({
        liminaOptions: {
          outputs: {
            unknownFutureField: true,
          },
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/managed/src/index.ts': 'export const value = 1;\n',
      'packages/managed/tsconfig.json': tsconfig({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await runBuild({
        checker: 'tsc',
        config: {
          config: {
            checkers: {
              typescript: {
                include: ['packages/managed/tsconfig.json'],
                preset: 'tsc',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        configPath: 'packages/app/tsconfig.raw.json',
        cwd: fixture.rootDir,
        raw: true,
        runner: passingRunner(calls),
      });

      expect(result.passed).toBe(true);
      expect(calls.map((target) => target.args)).toEqual([
        ['-b', 'packages/app/tsconfig.raw.json', '--pretty', 'false'],
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports source configs governed only by typecheck-only checkers', async () => {
    const calls: TypecheckTarget[] = [];
    const errorSpy = vi
      .spyOn(TypecheckLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture({
      'svelte/tsconfig.json': tsconfig({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'svelte/src/index.ts': 'export const value = 1;\n',
    });

    try {
      const result = await runBuild({
        config: {
          config: {
            checkers: {
              svelte: {
                include: ['svelte/tsconfig.json'],
                preset: 'svelte-check',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        cwd: fixture.rootDir,
        configPath: 'svelte/tsconfig.json',
        runner: passingRunner(calls),
      });

      expect(result.passed).toBe(false);
      expect(calls).toHaveLength(0);
      expect(errorSpy.mock.calls.join('\n')).toContain('typecheck-only');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('rejects multiple output build owners before preset selection', async () => {
    const calls: TypecheckTarget[] = [];
    const errorSpy = vi
      .spyOn(TypecheckLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture({
      'packages/native/tsconfig.json': tsconfig({
        files: [],
        references: [
          {
            path: '../shared/tsconfig.lib.json',
          },
        ],
      }),
      'packages/ts/tsconfig.json': tsconfig({
        files: [],
        references: [
          {
            path: '../shared/tsconfig.lib.json',
          },
        ],
      }),
      'packages/shared/src/index.ts': 'export const value = 1;\n',
      'packages/shared/tsconfig.lib.json': tsconfig({
        liminaOptions: {
          outputs: {},
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      await expect(
        runBuild({
          config: {
            config: {
              checkers: {
                nativeTypescript: {
                  include: ['packages/native/tsconfig.json'],
                  preset: 'tsgo',
                },
                typescript: {
                  include: ['packages/ts/tsconfig.json'],
                  preset: 'tsc',
                },
              },
            },
            configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
            rootDir: fixture.rootDir,
          },
          cwd: fixture.rootDir,
          configPath: 'packages/shared/tsconfig.lib.json',
          runner: passingRunner(calls),
        }),
      ).rejects.toThrow('Output build cache boundary conflict');
      expect(calls).toHaveLength(0);
      expect(errorSpy.mock.calls.join('\n')).toContain(
        'Output build cache boundary conflict',
      );
      expect(errorSpy.mock.calls.join('\n')).toContain('tsgo');
      expect(errorSpy.mock.calls.join('\n')).toContain('tsc');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('builds only the requested managed checker preset when it covers the config', async () => {
    const calls: TypecheckTarget[] = [];
    const fixture = await createFixture({
      'packages/native/src/index.ts': 'export const nativeValue = 1;\n',
      'packages/native/tsconfig.json': tsconfig({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/ts/tsconfig.json': tsconfig({
        files: [],
        references: [
          {
            path: '../shared/tsconfig.lib.json',
          },
        ],
      }),
      'packages/shared/src/index.ts': 'export const value = 1;\n',
      'packages/shared/tsconfig.lib.json': tsconfig({
        liminaOptions: {
          outputs: {},
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await runBuild({
        checker: 'tsc',
        config: {
          config: {
            checkers: {
              nativeTypescript: {
                include: ['packages/native/tsconfig.json'],
                preset: 'tsgo',
              },
              typescript: {
                include: ['packages/ts/tsconfig.json'],
                preset: 'tsc',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        cwd: fixture.rootDir,
        project: 'packages/shared/tsconfig.lib.json',
        runner: passingRunner(calls),
      });

      expect(result.passed).toBe(true);
      expect(calls.map((target) => target.command)).toEqual(['tsc']);
      expect(calls.map((target) => target.args)).toEqual([
        [
          '-b',
          '.limina/tsconfig/checkers/typescript/outputs/projects/packages/shared/tsconfig.lib.output.json',
          '--pretty',
          'false',
        ],
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports requested managed checker presets that do not cover the config', async () => {
    const calls: TypecheckTarget[] = [];
    const errorSpy = vi
      .spyOn(TypecheckLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture({
      'packages/app/src/index.ts': 'export const value = 1;\n',
      'packages/app/tsconfig.json': tsconfig({
        liminaOptions: {
          outputs: {},
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await runBuild({
        checker: 'vue-tsc',
        config: {
          config: {
            checkers: {
              typescript: {
                include: ['packages/app/tsconfig.json'],
                preset: 'tsc',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        cwd: fixture.rootDir,
        configPath: 'packages/app/tsconfig.json',
        runner: passingRunner(calls),
      });

      expect(result.passed).toBe(false);
      expect(calls).toHaveLength(0);
      expect(errorSpy.mock.calls.join('\n')).toContain(
        'Invalid Limina build preset',
      );
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('rejects tsc and vue-tsc output owners for the same source config', async () => {
    const calls: TypecheckTarget[] = [];
    const errorSpy = vi
      .spyOn(TypecheckLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture({
      'packages/shared/src/index.ts': 'export const value = 1;\n',
      'packages/shared/tsconfig.lib.json': tsconfig({
        liminaOptions: {
          outputs: {},
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/ts/tsconfig.json': tsconfig({
        files: [],
        references: [
          {
            path: '../shared/tsconfig.lib.json',
          },
        ],
      }),
      'packages/vue/tsconfig.json': tsconfig({
        files: [],
        references: [
          {
            path: '../shared/tsconfig.lib.json',
          },
        ],
      }),
    });

    try {
      await expect(
        runBuild({
          config: {
            config: {
              checkers: {
                typescript: {
                  include: ['packages/ts/tsconfig.json'],
                  preset: 'tsc',
                },
                vue: {
                  include: ['packages/vue/tsconfig.json'],
                  preset: 'vue-tsc',
                },
              },
            },
            configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
            rootDir: fixture.rootDir,
          },
          cwd: fixture.rootDir,
          project: 'packages/shared/tsconfig.lib.json',
          runner: passingRunner(calls),
        }),
      ).rejects.toThrow('Output build cache boundary conflict');
      expect(calls).toHaveLength(0);
      expect(errorSpy.mock.calls.join('\n')).toContain(
        'Output build cache boundary conflict',
      );
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('rejects incompatible cross-engine provider traversal before failed checker builds', async () => {
    const calls: TypecheckTarget[] = [];
    const errorSpy = vi
      .spyOn(TypecheckLogger, 'error')
      .mockImplementation(() => {});
    const warnSpy = vi
      .spyOn(TypecheckLogger, 'warn')
      .mockImplementation(() => {});
    const fixture = await createFixture({
      'packages/shared/src/index.ts': 'export const sharedValue = 1;\n',
      'packages/shared/tsconfig.json': tsconfig({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/theme/src/index.ts':
        "import { sharedValue } from '../../shared/src/index';\nexport const themeValue = sharedValue;\n",
      'packages/theme/tsconfig.json': tsconfig({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      await expect(
        runCheckerBuild({
          config: {
            config: {
              checkers: {
                nativeTypescript: {
                  include: ['packages/shared/tsconfig.json'],
                  preset: 'tsgo',
                },
                vue: {
                  include: ['packages/theme/tsconfig.json'],
                  preset: 'vue-tsc',
                },
              },
            },
            configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
            rootDir: fixture.rootDir,
          },
          cwd: fixture.rootDir,
          runner: failingRunner(calls),
        }),
      ).rejects.toThrow('Unsafe cross-engine declaration provider');
      expect(calls).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy.mock.calls.join('\n')).toContain(
        'Unsafe cross-engine declaration provider',
      );
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('rejects cross-engine providers before running builds', async () => {
    const calls: TypecheckTarget[] = [];
    const errorSpy = vi
      .spyOn(TypecheckLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture({
      'packages/app/src/index.ts':
        "import { themeValue } from '../../theme/src/theme';\nexport const value = themeValue;\n",
      'packages/app/tsconfig.json': tsconfig({
        liminaOptions: {
          outputs: {},
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/theme/src/Theme.vue':
        '<script setup lang="ts">const value = 1;</script>\n',
      'packages/theme/src/theme.ts': 'export const themeValue = 1;\n',
      'packages/theme/tsconfig.json': tsconfig({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts', 'src/**/*.vue'],
      }),
    });

    try {
      let thrown: unknown;

      try {
        await runBuild({
          config: {
            config: {
              checkers: {
                typescript: {
                  include: ['packages/app/tsconfig.json'],
                  preset: 'tsc',
                },
                vue: {
                  include: ['packages/theme/tsconfig.json'],
                  preset: 'vue-tsc',
                },
              },
            },
            configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
            rootDir: fixture.rootDir,
          },
          cwd: fixture.rootDir,
          project: 'packages/app',
          runner: passingRunner(calls),
        });
      } catch (error) {
        thrown = error;
      }

      expect(String(thrown)).toContain(
        'Unsafe cross-engine declaration provider',
      );
      expect(String(thrown)).toContain(
        'consumer checker: typescript (tsc, engine: tsc)',
      );
      expect(String(thrown)).toContain('vue (vue-tsc, engine: vue-tsc)');
      expect(String(thrown)).toContain('packages/theme/src/theme.ts');
      expect(calls).toEqual([]);
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('rejects cross-engine cyclic provider candidates before closure checks', async () => {
    const calls: TypecheckTarget[] = [];
    const errorSpy = vi
      .spyOn(TypecheckLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture({
      'packages/app/src/index.ts':
        "import { themeValue } from '../../theme/src/theme';\nexport const value = themeValue;\n",
      'packages/app/tsconfig.json': tsconfig({
        liminaOptions: {
          outputs: {},
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/theme/src/theme.ts': 'export const themeValue = 1;\n',
      'packages/theme/tsconfig.json': tsconfig({
        liminaOptions: {
          implicitRefs: [
            {
              path: '../widgets/tsconfig.json',
              reason: 'Widgets are loaded by a generated theme manifest.',
            },
          ],
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/widgets/src/Widget.vue':
        '<script setup lang="ts">const value = 1;</script>\n',
      'packages/widgets/src/widget.ts': 'export const widgetValue = 1;\n',
      'packages/widgets/tsconfig.json': tsconfig({
        liminaOptions: {
          implicitRefs: [
            {
              path: '../theme/tsconfig.json',
              reason: 'Theme metadata is loaded by generated widgets.',
            },
          ],
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts', 'src/**/*.vue'],
      }),
    });

    try {
      let thrown: unknown;

      try {
        await runBuild({
          config: {
            config: {
              checkers: {
                typescript: {
                  include: ['packages/app/tsconfig.json'],
                  preset: 'tsc',
                },
                vue: {
                  include: [
                    'packages/theme/tsconfig.json',
                    'packages/widgets/tsconfig.json',
                  ],
                  preset: 'vue-tsc',
                },
              },
            },
            configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
            rootDir: fixture.rootDir,
          },
          cwd: fixture.rootDir,
          project: 'packages/app',
          runner: passingRunner(calls),
        });
      } catch (error) {
        thrown = error;
      }

      expect(String(thrown)).toContain(
        'Unsafe cross-engine declaration provider',
      );
      expect(String(thrown)).toContain('vue (vue-tsc, engine: vue-tsc)');
      expect(String(thrown)).toContain('packages/theme/src/theme.ts');
      expect(calls).toEqual([]);
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('builds cross-checker providers before consumers', async () => {
    const calls: TypecheckTarget[] = [];
    const delayed = delayedRunner({
      calls,
      delayMs: (target) =>
        target.configPath.includes('packages/theme') ? 30 : 10,
    });
    const fixture = await createFixture({
      'packages/app/src/index.ts':
        "import { themeValue } from '../../theme/src/theme';\nexport const value = themeValue;\n",
      'packages/app/tsconfig.json': tsconfig({
        liminaOptions: {
          outputs: {},
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/theme/src/theme.ts': 'export const themeValue = 1;\n',
      'packages/theme/tsconfig.json': tsconfig({
        liminaOptions: {
          outputs: {},
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await runBuild({
        config: {
          config: {
            checkers: {
              typescript: {
                include: ['packages/app/tsconfig.json'],
                preset: 'tsc',
              },
              themeTypescript: {
                include: ['packages/theme/tsconfig.json'],
                preset: 'tsc',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        cwd: fixture.rootDir,
        project: 'packages/app',
        runner: delayed.runner,
      });

      expect(result.passed).toBe(true);
      expect(calls.map((target) => target.command)).toEqual(['tsc', 'tsc']);
      expect(delayed.getMaxActive()).toBe(1);
      expect(calls.map((target) => target.args)).toEqual([
        [
          '-b',
          '.limina/tsconfig/checkers/themeTypescript/outputs/projects/packages/theme/tsconfig.output.json',
          '--pretty',
          'false',
        ],
        [
          '-b',
          '.limina/tsconfig/checkers/typescript/outputs/projects/packages/app/tsconfig.output.json',
          '--pretty',
          'false',
        ],
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('starts all managed targets concurrently in watch mode', async () => {
    const calls: TypecheckTarget[] = [];
    const delayed = delayedRunner({
      calls,
      delayMs: () => 30,
    });
    const fixture = await createFixture({
      'packages/app/src/index.ts':
        "import { themeValue } from '../../theme/src/theme';\nexport const value = themeValue;\n",
      'packages/app/tsconfig.json': tsconfig({
        liminaOptions: {
          outputs: {},
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/theme/src/theme.ts': 'export const themeValue = 1;\n',
      'packages/theme/tsconfig.json': tsconfig({
        liminaOptions: {
          outputs: {},
        },
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    });

    try {
      const result = await runBuild({
        config: {
          config: {
            checkers: {
              typescript: {
                include: ['packages/app/tsconfig.json'],
                preset: 'tsc',
              },
              themeTypescript: {
                include: ['packages/theme/tsconfig.json'],
                preset: 'tsc',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        cwd: fixture.rootDir,
        project: 'packages/app',
        runner: delayed.runner,
        watch: true,
      });

      expect(result.passed).toBe(true);
      expect(calls.map((target) => target.command).sort()).toEqual([
        'tsc',
        'tsc',
      ]);
      expect(delayed.getMaxActive()).toBe(2);
      expect(calls.map((target) => target.args)).toEqual(
        expect.arrayContaining([
          [
            '-b',
            '.limina/tsconfig/checkers/typescript/outputs/projects/packages/app/tsconfig.output.json',
            '--pretty',
            'false',
            '--watch',
            '--preserveWatchOutput',
          ],
          [
            '-b',
            '.limina/tsconfig/checkers/themeTypescript/outputs/projects/packages/theme/tsconfig.output.json',
            '--pretty',
            'false',
            '--watch',
            '--preserveWatchOutput',
          ],
        ]),
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('runCheckerTypecheck', () => {
  it('runs only second-class checker entries', async () => {
    const calls: TypecheckTarget[] = [];
    const fixture = await createFixture({
      'tsconfig.build.json': tsconfig({ files: [] }),
      'tsconfig.svelte.build.json': tsconfig({ files: [] }),
      'tsconfig.vue.build.json': tsconfig({ files: [] }),
    });

    try {
      const result = await runCheckerTypecheck({
        config: createLiminaConfig(fixture.rootDir),
        cwd: fixture.rootDir,
        runner: passingRunner(calls),
      });

      expect(result.passed).toBe(true);
      expect(calls.map((target) => target.command)).toEqual(['svelte-check']);
      expect(calls.map((target) => target.args)).toEqual([
        ['--tsconfig', '.limina/tsconfig/checkers/svelte/tsconfig.build.json'],
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('runs vue-tsgo checker entries with second-class project mode', async () => {
    const calls: TypecheckTarget[] = [];
    const fixture = await createFixture({
      'tsconfig.vue.build.json': tsconfig({ files: [] }),
    });

    try {
      const result = await runCheckerTypecheck({
        config: {
          config: {
            checkers: {
              vue: {
                include: ['vue/tsconfig.json'],
                preset: 'vue-tsgo',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        cwd: fixture.rootDir,
        runner: passingRunner(calls),
      });

      expect(result.passed).toBe(true);
      expect(calls.map((target) => target.command)).toEqual(['vue-tsgo']);
      expect(calls.map((target) => target.args)).toEqual([
        ['--project', '.limina/tsconfig/checkers/vue/tsconfig.build.json'],
      ]);
      expect(calls.map((target) => target.label)).toEqual([
        'vue: vue-tsgo --project .limina/tsconfig/checkers/vue/tsconfig.build.json',
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('requires vue-tsgo and the native preview package for vue-tsgo second-class entries', async () => {
    const calls: TypecheckTarget[] = [];
    const errorSpy = vi
      .spyOn(TypecheckLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture({
      'tsconfig.vue.build.json': tsconfig({ files: [] }),
    });

    try {
      const result = await runCheckerTypecheck({
        checkerPackageResolver: ({ packageName }) =>
          packageName === 'vue-tsgo' ? packageName : undefined,
        config: {
          config: {
            checkers: {
              vue: {
                include: ['vue/tsconfig.json'],
                preset: 'vue-tsgo',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        cwd: fixture.rootDir,
        runner: passingRunner(calls),
      });

      expect(result.passed).toBe(false);
      expect(calls).toHaveLength(0);
      expect(errorSpy.mock.calls.join('\n')).toContain(
        '@typescript/native-preview',
      );
      expect(errorSpy.mock.calls.join('\n')).toContain(
        'Fix: pnpm add -D @typescript/native-preview',
      );
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('clears stale vue-tsgo cache before using the second-class default runner', async () => {
    const fixture = await createFixture({
      'package.json': tsconfig({
        name: 'fixture',
        type: 'module',
      }),
      'tsconfig.vue.build.json': tsconfig({ files: [] }),
      'node_modules/.bin/vue-tsgo': [
        '#!/usr/bin/env sh',
        'exec node "$(dirname "$0")/vue-tsgo.js" "$@"',
        '',
      ].join('\n'),
      'node_modules/.bin/vue-tsgo.cmd': [
        '@ECHO OFF',
        'node "%~dp0vue-tsgo.js" %*',
        '',
      ].join('\r\n'),
      'node_modules/.bin/vue-tsgo.js': [
        "import { createHash } from 'node:crypto';",
        "import { existsSync, writeFileSync } from 'node:fs';",
        "import path from 'node:path';",
        'const configPath = path.resolve(process.cwd(), process.argv.at(-1));',
        "const hash = createHash('sha256').update(configPath).digest('hex').slice(0, 8);",
        "const stalePath = path.join(process.cwd(), 'node_modules/.cache/vue-tsgo', hash, 'stale.txt');",
        "writeFileSync(path.join(process.cwd(), 'stale-state.txt'), String(existsSync(stalePath)));",
        '',
      ].join('\n'),
    });

    try {
      await chmod(
        path.join(fixture.rootDir, 'node_modules/.bin/vue-tsgo'),
        0o755,
      );
      await writeText(
        path.join(
          fixture.rootDir,
          'node_modules/.cache/vue-tsgo',
          createHash('sha256')
            .update(path.join(fixture.rootDir, 'tsconfig.vue.build.json'))
            .digest('hex')
            .slice(0, 8),
          'stale.txt',
        ),
        'stale\n',
      );

      const result = await runCheckerTypecheck({
        config: {
          config: {
            checkers: {
              vue: {
                include: ['vue/tsconfig.json'],
                preset: 'vue-tsgo',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        cwd: fixture.rootDir,
      });
      const staleState = await readFile(
        path.join(fixture.rootDir, 'stale-state.txt'),
        'utf8',
      );

      expect(result.passed).toBe(true);
      expect(staleState).toBe('false');
    } finally {
      await fixture.cleanup();
    }
  });

  it('skips graph preparation and build-only peer checks when no second-class checkers are configured', async () => {
    const calls: TypecheckTarget[] = [];
    const generatedGraphProvider = vi.fn(async () => {
      throw new Error('generated graph should not be read');
    });
    const fixture = await createFixture({
      'tsconfig.build.json': tsconfig({ files: [] }),
      'tsconfig.vue.build.json': tsconfig({ files: [] }),
    });

    try {
      const result = await runCheckerTypecheck({
        config: {
          config: {
            checkers: {
              typescript: {
                include: ['tsconfig.json'],
                preset: 'tsc',
              },
              vue: {
                include: ['vue/tsconfig.json'],
                preset: 'vue-tsc',
              },
            },
          },
          configPath: path.join(fixture.rootDir, 'limina.config.mjs'),
          rootDir: fixture.rootDir,
        },
        checkerPackageResolver: (): string | undefined => undefined,
        cwd: fixture.rootDir,
        generatedGraphProvider,
        runner: passingRunner(calls),
      });

      expect(result.passed).toBe(true);
      expect(calls).toHaveLength(0);
      expect(generatedGraphProvider).not.toHaveBeenCalled();
      expect(existsSync(path.join(fixture.rootDir, '.limina'))).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });
});
