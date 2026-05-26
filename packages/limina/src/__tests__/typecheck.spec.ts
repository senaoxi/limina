import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CheckerPackageResolver } from '../checkers';
import {
  runCheckerBuild as runCheckerBuildCommand,
  runCheckerTypecheck as runCheckerTypecheckCommand,
  type RunCheckerBuildOptions,
  type RunCheckerTypecheckOptions,
  type TypecheckTarget,
  type TypecheckTargetResult,
} from '../commands/typecheck';
import type { ResolvedLiminaConfig } from '../config';
import { TypecheckLogger } from '../logger';

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

function createLiminaConfig(rootDir: string): ResolvedLiminaConfig {
  return {
    config: {
      checkers: {
        svelte: {
          entry: 'tsconfig.svelte.build.json',
          preset: 'svelte-check',
        },
        typescript: {
          entry: 'tsconfig.build.json',
          preset: 'tsc',
        },
        vue: {
          entry: 'tsconfig.vue.build.json',
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
        ['-b', 'tsconfig.build.json', '--pretty', 'false'],
        ['-b', 'tsconfig.vue.build.json', '--pretty', 'false'],
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('fails before running checker entries when a configured peer is missing', async () => {
    const calls: TypecheckTarget[] = [];
    const errorSpy = vi
      .spyOn(TypecheckLogger, 'error')
      .mockImplementation(() => undefined);
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
                entry: 'tsconfig.build.json',
                preset: 'tsc',
              },
              vue: {
                entry: 'tsconfig.vue.build.json',
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

      expect(result.passed).toBe(false);
      expect(calls).toHaveLength(0);
      expect(errorSpy.mock.calls.join('\n')).toContain('@vue/compiler-sfc');
      expect(errorSpy.mock.calls.join('\n')).toContain(
        'Fix: pnpm add -D @vue/compiler-sfc',
      );
    } finally {
      errorSpy.mockRestore();
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
});

describe('runCheckerTypecheck', () => {
  it('runs only source-only checker entries', async () => {
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
        ['--tsconfig', 'tsconfig.svelte.build.json'],
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('passes without running targets when no source-only checkers are configured', async () => {
    const calls: TypecheckTarget[] = [];
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
                entry: 'tsconfig.build.json',
                preset: 'tsc',
              },
              vue: {
                entry: 'tsconfig.vue.build.json',
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
      expect(calls).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });
});
