import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { createLiminaCli } from '../cli';

const execFileAsync = promisify(execFile);
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

function stringifyConfig(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeBinShim(
  rootDir: string,
  command: string,
  script: string,
): Promise<void> {
  const scriptPath = path.join(rootDir, 'node_modules/.bin', `${command}.cjs`);

  await writeText(scriptPath, script);
  await writeText(
    path.join(rootDir, 'node_modules/.bin', command),
    [
      '#!/usr/bin/env sh',
      `exec node "$(dirname "$0")/${command}.cjs" "$@"`,
      '',
    ].join('\n'),
  );
  await chmod(path.join(rootDir, 'node_modules/.bin', command), 0o755);
  await writeText(
    path.join(rootDir, 'node_modules/.bin', `${command}.cmd`),
    ['@ECHO OFF', `node "%~dp0${command}.cjs" %*`, ''].join('\r\n'),
  );
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
  rootDir: '.',
  strict: true,
  target: 'ES2023',
  tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
  types: [],
};

interface CliBuildFixture {
  cliPath: string;
  rootDir: string;
}

async function createCliBuildFixture(): Promise<CliBuildFixture> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-cli-build-')),
  );
  const cliPath = fileURLToPath(
    new URL('../../bin/limina.js', import.meta.url),
  );

  await writeText(
    path.join(rootDir, 'pnpm-workspace.yaml'),
    'packages:\n  - packages/*\n',
  );
  await writeText(
    path.join(rootDir, 'package.json'),
    stringifyConfig({
      name: 'root',
      private: true,
    }),
  );
  await writeText(
    path.join(rootDir, 'limina.config.mjs'),
    `export default ${JSON.stringify(
      {
        config: {
          checkers: {
            typescript: {
              include: ['packages/pkg/tsconfig.json'],
              preset: 'tsc',
            },
          },
        },
      },
      null,
      2,
    )};\n`,
  );
  await writeBinShim(
    rootDir,
    'tsc',
    [
      "const { writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      "writeFileSync(join(process.cwd(), 'tsc-args.txt'), `${process.argv.slice(2).join('\\n')}\\n`);",
      '',
    ].join('\n'),
  );
  await writeText(
    path.join(rootDir, 'node_modules/typescript/package.json'),
    stringifyConfig({
      name: 'typescript',
      version: '0.0.0-test',
    }),
  );
  await writeBinShim(
    rootDir,
    'vue-tsc',
    [
      "const { writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      "writeFileSync(join(process.cwd(), 'vue-tsc-args.txt'), `${process.argv.slice(2).join('\\n')}\\n`);",
      '',
    ].join('\n'),
  );
  await writeText(
    path.join(rootDir, 'node_modules/vue-tsc/package.json'),
    stringifyConfig({
      name: 'vue-tsc',
      version: '0.0.0-test',
    }),
  );
  await writeText(
    path.join(rootDir, 'node_modules/@vue/compiler-sfc/package.json'),
    stringifyConfig({
      name: '@vue/compiler-sfc',
      version: '0.0.0-test',
    }),
  );
  await writeText(
    path.join(rootDir, 'packages/pkg/src/index.ts'),
    'export const value = 1;\n',
  );
  await writeText(
    path.join(rootDir, 'packages/pkg/tsconfig.lib.json'),
    stringifyConfig({
      liminaOptions: {
        outputs: {},
      },
      compilerOptions: {
        ...buildCompilerOptions,
        noEmit: true,
      },
      include: ['src/**/*.ts'],
    }),
  );
  await writeText(
    path.join(rootDir, 'packages/pkg/tsconfig.json'),
    stringifyConfig({
      files: [],
      references: [
        {
          path: './tsconfig.lib.json',
        },
      ],
    }),
  );

  return {
    cliPath,
    rootDir,
  };
}

async function withCliBuildFixture(
  callback: (fixture: CliBuildFixture) => Promise<void>,
): Promise<void> {
  const fixture = await createCliBuildFixture();

  try {
    await callback(fixture);
  } finally {
    await rm(fixture.rootDir, {
      force: true,
      recursive: true,
    });
  }
}

function getHelpOutput(argv: string[]): string {
  const output: string[] = [];
  const consoleLog = vi.spyOn(console, 'log').mockImplementation((...args) => {
    output.push(args.map(String).join(' '));
  });

  try {
    createLiminaCli().parse(argv, { run: false });
  } finally {
    consoleLog.mockRestore();
  }

  return output.join('\n');
}

describe('limina CLI', () => {
  it('shows graph export options without the removed task orchestrator command', () => {
    const rootHelp = getHelpOutput(['node', 'limina', '--help']);
    const graphHelp = getHelpOutput(['node', 'limina', 'graph', '--help']);

    expect(rootHelp).toContain('checker <action> [config]');
    expect(rootHelp).toContain('build <config>');
    expect(rootHelp).toContain('graph <action>');
    expect(rootHelp).not.toContain('nx <action>');
    expect(graphHelp).toContain('--view <view>');
    expect(graphHelp).toContain('--output <path>');
  });

  it('runs checker build for a selected source config from the public command', async () => {
    await withCliBuildFixture(async ({ cliPath, rootDir }) => {
      const result = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'checker',
          'build',
          'packages/pkg/tsconfig.lib.json',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );
      const tscArgs = await readFile(
        path.join(rootDir, 'tsc-args.txt'),
        'utf8',
      );

      expect(result.stdout).toContain('limina checker build');
      expect(result.stdout).toContain('limina checker passed');
      expect(tscArgs).toContain(
        '.limina/tsconfig/checkers/typescript/projects/packages/pkg/tsconfig.lib.dts.json',
      );
    });
  });

  it('loads a TypeScript config through the public --config-loader flag', async () => {
    await withCliBuildFixture(async ({ cliPath, rootDir }) => {
      const tsConfigPath = path.join(rootDir, 'limina.config.ts');

      await writeText(
        tsConfigPath,
        `
enum Preset {
  Tsc = 'tsc',
}

export default {
  config: {
    checkers: {
      typescript: {
        include: ['packages/pkg/tsconfig.json'],
        preset: Preset.Tsc,
      },
    },
  },
};
`,
      );

      await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          tsConfigPath,
          '--config-loader',
          'tsx',
          'checker',
          'build',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );

      const tscArgs = await readFile(
        path.join(rootDir, 'tsc-args.txt'),
        'utf8',
      );

      expect(tscArgs).toContain(
        '.limina/tsconfig/checkers/typescript/tsconfig.build.json',
      );
    });
  });

  it('runs checker build globally from the public command', async () => {
    await withCliBuildFixture(async ({ cliPath, rootDir }) => {
      await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'checker',
          'build',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );

      const globalTscArgs = await readFile(
        path.join(rootDir, 'tsc-args.txt'),
        'utf8',
      );

      expect(globalTscArgs).toContain(
        '.limina/tsconfig/checkers/typescript/tsconfig.build.json',
      );
    });
  });

  it('runs managed output build from the public command', async () => {
    await withCliBuildFixture(async ({ cliPath, rootDir }) => {
      const result = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'build',
          'packages/pkg/tsconfig.lib.json',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );
      const tscArgs = await readFile(
        path.join(rootDir, 'tsc-args.txt'),
        'utf8',
      );

      expect(result.stdout).toContain('limina build');
      expect(result.stdout).toContain('limina build passed');
      expect(tscArgs).toContain(
        '.limina/tsconfig/checkers/typescript/outputs/projects/packages/pkg/tsconfig.lib.output.json',
      );
    });
  });

  it('runs raw build with the requested preset from the public command', async () => {
    await withCliBuildFixture(async ({ cliPath, rootDir }) => {
      await writeText(
        path.join(rootDir, 'packages/raw/src/index.vue'),
        '<script setup lang="ts"></script>\n',
      );
      await writeText(
        path.join(rootDir, 'packages/raw/tsconfig.raw.json'),
        stringifyConfig({
          compilerOptions: {
            ...buildCompilerOptions,
            noEmit: true,
          },
          include: ['src/**/*.vue'],
        }),
      );

      await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'build',
          'packages/raw/tsconfig.raw.json',
          '--raw',
          '--preset',
          'vue-tsc',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );

      const vueTscArgs = await readFile(
        path.join(rootDir, 'vue-tsc-args.txt'),
        'utf8',
      );

      expect(vueTscArgs).toContain('packages/raw/tsconfig.raw.json');
    });
  });

  it('passes watch flags through checker build from the public command', async () => {
    await withCliBuildFixture(async ({ cliPath, rootDir }) => {
      await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'checker',
          'build',
          'packages/pkg/tsconfig.lib.json',
          '-w',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );
      const watchTscArgs = await readFile(
        path.join(rootDir, 'tsc-args.txt'),
        'utf8',
      );

      expect(watchTscArgs).toContain('--watch');
      expect(watchTscArgs).toContain('--preserveWatchOutput');
    });
  });

  it('hides checker build process output from the check command', async () => {
    await withCliBuildFixture(async ({ cliPath, rootDir }) => {
      const secretError = 'SECRET_CHECKER_BUILD_FAILURE';

      await writeText(
        path.join(rootDir, 'packages/pkg/package.json'),
        stringifyConfig({
          exports: {
            '.': './src/index.ts',
          },
          name: '@example/pkg',
          scripts: {
            build: 'limina build tsconfig.json',
          },
          type: 'module',
        }),
      );
      await writeBinShim(
        rootDir,
        'tsc',
        [
          `process.stderr.write(${JSON.stringify(`${secretError}\n`)});`,
          'process.exit(2);',
          '',
        ].join('\n'),
      );

      let stdout = '';
      let stderr = '';

      try {
        await execFileAsync(
          process.execPath,
          [
            cliPath,
            '--config',
            path.join(rootDir, 'limina.config.mjs'),
            'check',
          ],
          {
            cwd: rootDir,
            env: {
              ...process.env,
              CI: 'true',
            },
          },
        );
        throw new Error('Expected limina check to fail.');
      } catch (error) {
        expect(error).toMatchObject({
          code: 1,
        });
        stdout =
          typeof (error as { stdout?: unknown }).stdout === 'string'
            ? (error as { stdout: string }).stdout
            : '';
        stderr =
          typeof (error as { stderr?: unknown }).stderr === 'string'
            ? (error as { stderr: string }).stderr
            : '';
      }

      expect(stdout).toContain('Limina check summary');
      expect(stdout).toContain('checker:build');
      expect(`${stdout}\n${stderr}`).not.toContain(secretError);
      expect(`${stdout}\n${stderr}`).not.toContain(
        `Checker build failed: ${secretError}`,
      );
    });
  }, 30_000);

  it('rejects removed and invalid checker build options from the public command', async () => {
    const cliPath = fileURLToPath(
      new URL('../../bin/limina.js', import.meta.url),
    );

    await expect(
      execFileAsync(process.execPath, [
        cliPath,
        'checker',
        'build',
        '--preset',
        'vue-tsc',
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        'checker build --preset requires a config argument.',
      ),
    });

    await expect(
      execFileAsync(process.execPath, [cliPath, 'checker', 'build', '--watch']),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        'checker build --watch requires a config argument.',
      ),
    });

    await expect(
      execFileAsync(process.execPath, [
        cliPath,
        'checker',
        'build',
        'packages/pkg/tsconfig.lib.json',
        '--checker',
        'vue-tsc',
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        'Unknown option: --checker. Use --preset instead.',
      ),
    });

    await expect(
      execFileAsync(process.execPath, [
        cliPath,
        'checker',
        'build',
        '--project',
        'packages/pkg/tsconfig.lib.json',
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        'Unknown option: --project. Pass the config as a positional argument.',
      ),
    });

    await expect(
      execFileAsync(process.execPath, [
        cliPath,
        'build',
        'packages/pkg/tsconfig.lib.json',
        '--raw',
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('limina build --raw requires --preset.'),
    });

    await expect(
      execFileAsync(process.execPath, [
        cliPath,
        'build',
        'packages/pkg/tsconfig.lib.json',
        '--raw',
        '--preset',
        'vue-tsgo',
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        'Invalid build --preset "vue-tsgo". Expected one of: tsc, vue-tsc, tsgo.',
      ),
    });

    await expect(
      execFileAsync(process.execPath, [
        cliPath,
        'build',
        'packages/pkg/tsconfig.lib.json',
        '--raw',
        '--preset',
        'svelte-check',
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        'Invalid build --preset "svelte-check". Expected one of: tsc, vue-tsc, tsgo.',
      ),
    });
  });

  it('runs source check from the public command', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-cli-')),
    );
    const cliPath = fileURLToPath(
      new URL('../../bin/limina.js', import.meta.url),
    );

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages:\n  - app\n',
      );
      await writeText(
        path.join(rootDir, 'package.json'),
        stringifyConfig({
          name: 'root',
          private: true,
        }),
      );
      await writeText(
        path.join(rootDir, 'app/package.json'),
        stringifyConfig({
          name: 'app',
          private: true,
        }),
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `export default ${JSON.stringify(
          {
            config: {
              checkers: {
                typescript: {
                  include: ['app/tsconfig.json'],
                  preset: 'tsc',
                },
              },
            },
          },
          null,
          2,
        )};\n`,
      );
      await writeText(
        path.join(rootDir, 'tsconfig.build.json'),
        stringifyConfig({
          files: [],
          references: [
            {
              path: './app/tsconfig.lib.dts.json',
            },
          ],
        }),
      );
      await writeText(
        path.join(rootDir, 'app/package.json'),
        stringifyConfig({
          name: '@example/app',
          scripts: {
            build: 'limina build tsconfig.json',
          },
          type: 'module',
        }),
      );
      await writeText(
        path.join(rootDir, 'app/src/index.ts'),
        'export const value = 1;\n',
      );
      await writeText(
        path.join(rootDir, 'app/tsconfig.lib.dts.json'),
        stringifyConfig({
          compilerOptions: buildCompilerOptions,
          include: ['src/**/*.ts'],
        }),
      );
      await writeText(
        path.join(rootDir, 'app/tsconfig.json'),
        stringifyConfig({
          files: [],
          references: [
            {
              path: './tsconfig.lib.json',
            },
          ],
        }),
      );
      await writeText(
        path.join(rootDir, 'app/tsconfig.lib.json'),
        stringifyConfig({
          liminaOptions: {
            outputs: {},
          },
          compilerOptions: {
            ...buildCompilerOptions,
            noEmit: true,
          },
          include: ['src/**/*.ts'],
        }),
      );

      const result = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'source',
          'check',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );

      expect(result.stdout).toContain('limina source check');
      expect(result.stdout).toContain('limina source passed');
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  }, 15_000);

  it('prints source issue filters from the last run', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-cli-issues-')),
    );
    const cliPath = fileURLToPath(
      new URL('../../bin/limina.js', import.meta.url),
    );

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages:\n  - app\n',
      );
      await writeText(
        path.join(rootDir, 'package.json'),
        stringifyConfig({
          name: 'root',
          private: true,
        }),
      );
      await writeText(
        path.join(rootDir, 'app/package.json'),
        stringifyConfig({
          name: 'app',
          private: true,
        }),
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `export default ${JSON.stringify(
          {
            config: {
              checkers: {
                typescript: {
                  include: ['app/tsconfig.json'],
                  preset: 'tsc',
                },
              },
            },
          },
          null,
          2,
        )};\n`,
      );
      await writeText(
        path.join(rootDir, 'app/package.json'),
        stringifyConfig({
          exports: {
            '.': './src/index.ts',
          },
          name: '@example/app',
          scripts: {
            build: 'limina build tsconfig.json',
          },
          type: 'module',
        }),
      );
      await writeText(
        path.join(rootDir, 'app/src/index.ts'),
        'export const value = 1;\n',
      );
      await writeText(
        path.join(rootDir, 'app/src/theme/dead.ts'),
        'export const deadValue = 1;\n',
      );
      await writeText(
        path.join(rootDir, 'app/tsconfig.lib.dts.json'),
        stringifyConfig({
          compilerOptions: buildCompilerOptions,
          include: ['src/**/*.ts'],
        }),
      );
      await writeText(
        path.join(rootDir, 'app/tsconfig.json'),
        stringifyConfig({
          files: [],
          references: [
            {
              path: './tsconfig.lib.json',
            },
          ],
        }),
      );
      await writeText(
        path.join(rootDir, 'app/tsconfig.lib.json'),
        stringifyConfig({
          liminaOptions: {
            outputs: {},
          },
          compilerOptions: {
            ...buildCompilerOptions,
            noEmit: true,
          },
          include: ['src/**/*.ts'],
        }),
      );

      let checkFailureStdout = '';

      try {
        await execFileAsync(
          process.execPath,
          [
            cliPath,
            '--config',
            path.join(rootDir, 'limina.config.mjs'),
            'check',
          ],
          {
            cwd: rootDir,
            env: {
              ...process.env,
              CI: 'true',
            },
          },
        );
        throw new Error('Expected limina check to fail.');
      } catch (error) {
        expect(error).toMatchObject({
          code: 1,
        });
        checkFailureStdout =
          typeof (error as { stdout?: unknown }).stdout === 'string'
            ? (error as { stdout: string }).stdout
            : '';
      }
      const checkFailurePlainStdout = stripAnsi(checkFailureStdout);

      expect(checkFailurePlainStdout).toContain('Limina check summary');
      expect(checkFailurePlainStdout).not.toContain('Result: FAILED');
      expect(checkFailurePlainStdout).not.toContain('Blocked at: source:check');
      expect(checkFailurePlainStdout).toContain('Executed tasks: 5 / 5');
      expect(checkFailurePlainStdout).toContain('✕ source:check');
      expect(checkFailurePlainStdout).toContain('✕ knip source usage');
      expect(checkFailurePlainStdout).toContain('Next commands:');
      expect(checkFailurePlainStdout).toContain(
        'Verbose: limina check --issues --verbose',
      );
      expect(checkFailureStdout).toContain(
        `${ANSI_ESCAPE}[34mExecuted tasks:${ANSI_ESCAPE}[0m 5 / 5`,
      );
      expect(checkFailurePlainStdout).not.toContain('Source check summary');

      const result = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'check',
          '--issues',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );

      expect(result.stdout).toContain('Limina check issue summary');
      expect(result.stdout).toContain('Matched: 3 / 3 issues');
      expect(result.stdout).toContain('Command: limina check');
      expect(result.stdout).toContain('Issue overview:');
      expect(result.stdout).toContain('source:check (1)');
      expect(result.stdout).toContain('checker:build (1)');
      expect(result.stdout).toContain('proof:check (1)');
      expect(result.stdout).toContain('Packages: @example/app (1)');
      expect(result.stdout).toContain('1  LIMINA_SOURCE_UNUSED_MODULE');
      expect(result.stdout).toContain('Next commands:');
      expect(result.stdout).toContain(
        'limina check --issues --rule LIMINA_CHECKER_PEER_DEPENDENCY_MISSING --verbose',
      );

      const detailsResult = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'check',
          '--issues',
          '--verbose',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );
      expect(detailsResult.stdout).toContain('Check issue details');
      expect(detailsResult.stdout).toContain('Unused source module');
      expect(detailsResult.stdout).toContain('fix steps:');

      const jsonResult = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'check',
          '--issues',
          '--format',
          'json',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );
      const jsonPayload = JSON.parse(jsonResult.stdout) as {
        issueCount: number;
        issues: { code: string; task?: string; tool?: string }[];
        overview: { issueCount: number };
        topBlockers: { code: string; task: string }[];
      };

      expect(jsonPayload).toMatchObject({
        issueCount: 3,
        overview: {
          issueCount: 3,
        },
      });
      expect(jsonPayload.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'LIMINA_SOURCE_UNUSED_MODULE',
            tool: 'knip',
          }),
          expect.objectContaining({
            code: 'LIMINA_PROOF_DEFAULT_TSCONFIG_INVALID',
            task: 'proof:check',
          }),
          expect.objectContaining({
            code: 'LIMINA_CHECKER_PEER_DEPENDENCY_MISSING',
            task: 'checker:build',
          }),
        ]),
      );
      expect(jsonPayload.topBlockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'LIMINA_SOURCE_UNUSED_MODULE',
            task: 'source:check',
          }),
        ]),
      );

      const ndjsonResult = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'check',
          '--issues',
          '--format',
          'ndjson',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );
      const ndjsonIssues = ndjsonResult.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { code: string; tool?: string });

      expect(ndjsonIssues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'LIMINA_SOURCE_UNUSED_MODULE',
            tool: 'knip',
          }),
        ]),
      );
      expect(ndjsonResult.stdout).not.toContain('Limina check issue summary');

      const ruleFilteredResult = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'check',
          '--issues',
          '--rule',
          'LIMINA_SOURCE_UNUSED_MODULE',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );
      expect(ruleFilteredResult.stdout).toContain('Filters:');
      expect(ruleFilteredResult.stdout).toContain(
        'rule: LIMINA_SOURCE_UNUSED_MODULE',
      );
      expect(ruleFilteredResult.stdout).toContain('Matched: 1 / 3 issues');
      expect(ruleFilteredResult.stdout).toContain(
        '1  LIMINA_SOURCE_UNUSED_MODULE',
      );

      const packageFilteredResult = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'check',
          '--issues',
          '--package',
          '@example/app',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );
      expect(packageFilteredResult.stdout).toContain('Filters:');
      expect(packageFilteredResult.stdout).toContain('package: @example/app');
      expect(packageFilteredResult.stdout).toContain('Matched: 1 / 3 issues');

      const unmatchedRuleResult = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'check',
          '--issues',
          '--rule',
          'LIMINA_GRAPH_CHECK_FAILED',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );
      const normalizedUnmatchedRuleOutput = stripAnsi(
        unmatchedRuleResult.stdout,
      )
        .replaceAll(/\s*│\s*/gu, ' ')
        .replaceAll(/\s+/gu, ' ');
      expect(unmatchedRuleResult.stdout).toContain('Matched: 0 / 3 issues');
      expect(unmatchedRuleResult.stdout).toContain(
        'rule: LIMINA_GRAPH_CHECK_FAILED',
      );
      expect(unmatchedRuleResult.stdout).toContain('Top rules:');
      expect(unmatchedRuleResult.stdout).toContain('(none)');
      expect(unmatchedRuleResult.stdout).toContain('Filter diagnostics:');
      expect(normalizedUnmatchedRuleOutput).toContain(
        'Supported rule "LIMINA_GRAPH_CHECK_FAILED"',
      );
      expect(normalizedUnmatchedRuleOutput).toContain(
        'absent from the last snapshot.',
      );
      expect(normalizedUnmatchedRuleOutput).toContain(
        'limina check --issues --rule --help',
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  }, 40_000);

  it('reports missing and invalid check issue inventory requests', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-cli-issues-empty-')),
    );
    const cliPath = fileURLToPath(
      new URL('../../bin/limina.js', import.meta.url),
    );

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages:\n  - packages/*\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `export default ${JSON.stringify(
          {
            config: {
              checkers: {
                typescript: {
                  include: ['packages/app/tsconfig.json'],
                  preset: 'tsc',
                },
              },
            },
            package: {
              entries: [
                {
                  name: '@example/pkg-entry',
                  outDir: 'packages/pkg/dist',
                },
              ],
            },
          },
          null,
          2,
        )};\n`,
      );

      const result = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'check',
          '--issues',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );

      expect(result.stdout).toContain('No check issue snapshot found.');
      await writeText(
        path.join(rootDir, '.limina/check/last-run.json'),
        stringifyConfig({
          command: 'limina check',
          createdAt: '2026-06-21T00:00:00.000Z',
          issues: [],
          run: {
            command: 'limina check',
            createdAt: '2026-06-21T00:00:00.000Z',
            pipeline: 'default',
            result: 'passed',
            tasks: [
              {
                kind: 'task',
                name: 'source:check',
                status: 'passed',
              },
            ],
          },
          status: 'completed',
          version: 4,
        }),
      );

      const emptyTaskHelpResult = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          '--config-loader',
          'native',
          'check',
          '--issues',
          '--task',
          '--help',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );
      const emptyTaskHelpPlainStdout = stripAnsi(emptyTaskHelpResult.stdout);
      expect(emptyTaskHelpResult.stdout).toContain(`${ANSI_ESCAPE}[`);
      expect(emptyTaskHelpPlainStdout).toContain('Check issue tasks:');
      expect(emptyTaskHelpPlainStdout).toContain('- source:check  0 issues');
      expect(emptyTaskHelpPlainStdout).not.toContain(
        'No task filters are available',
      );

      const emptyPackageHelpResult = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'check',
          '--issues',
          '--package',
          '--help',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );
      const emptyPackageHelpPlainStdout = stripAnsi(
        emptyPackageHelpResult.stdout,
      );
      expect(emptyPackageHelpResult.stdout).toContain(`${ANSI_ESCAPE}[`);
      expect(emptyPackageHelpPlainStdout).toContain('Check issue packages:');
      expect(emptyPackageHelpPlainStdout).toContain(
        '- @example/pkg-entry  0 issues',
      );
      expect(emptyPackageHelpPlainStdout).not.toContain(
        'No package filters are available',
      );

      const emptyShortPackageHelpResult = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'check',
          '--issues',
          '-p',
          '--help',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );
      const emptyShortPackageHelpPlainStdout = stripAnsi(
        emptyShortPackageHelpResult.stdout,
      );
      expect(emptyShortPackageHelpResult.stdout).toContain(`${ANSI_ESCAPE}[`);
      expect(emptyShortPackageHelpPlainStdout).toContain(
        'Check issue packages:',
      );
      expect(emptyShortPackageHelpPlainStdout).toContain(
        '- @example/pkg-entry  0 issues',
      );

      const emptyCheckerHelpResult = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'check',
          '--issues',
          '--checker',
          '--help',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );
      const emptyCheckerHelpPlainStdout = stripAnsi(
        emptyCheckerHelpResult.stdout,
      );
      expect(emptyCheckerHelpResult.stdout).toContain(`${ANSI_ESCAPE}[`);
      expect(emptyCheckerHelpPlainStdout).toContain('Check issue checkers:');
      expect(emptyCheckerHelpPlainStdout).toContain('- typescript  0 issues');
      expect(emptyCheckerHelpPlainStdout).not.toContain(
        'No checker filters are available',
      );

      await writeText(
        path.join(rootDir, '.limina/check/last-run.json'),
        stringifyConfig({
          command: 'limina check',
          createdAt: '2026-06-21T00:00:00.000Z',
          issues: [
            {
              checkerName: 'typescript',
              code: 'LIMINA_CHECKER_BUILD_FAILED',
              packageName: '@example/app',
              reason: 'Checker build failed.',
              task: 'checker:build',
              title: 'Checker build failed',
            },
          ],
          status: 'completed',
          version: 4,
        }),
      );

      const ruleHelpResult = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'check',
          '--issues',
          '--rule',
          '--help',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );
      const ruleHelpPlainStdout = stripAnsi(ruleHelpResult.stdout);
      expect(ruleHelpResult.stdout).toContain(`${ANSI_ESCAPE}[`);
      expect(ruleHelpPlainStdout).toContain('Supported check issue rules:');
      expect(ruleHelpPlainStdout).toContain('source:check');
      expect(ruleHelpPlainStdout).toContain(
        'LIMINA_SOURCE_TSCONFIG_GOVERNANCE',
      );
      expect(ruleHelpPlainStdout).toContain(
        'source tsconfig is missing or outside checker governance',
      );
      expect(ruleHelpPlainStdout).not.toContain('Usage:');

      const taskHelpResult = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'check',
          '--issues',
          '--task',
          '--help',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );
      const taskHelpPlainStdout = stripAnsi(taskHelpResult.stdout);
      expect(taskHelpResult.stdout).toContain(`${ANSI_ESCAPE}[`);
      expect(taskHelpPlainStdout).toContain('Check issue tasks:');
      expect(taskHelpPlainStdout).toContain('- checker:build  1 issue');

      const packageHelpResult = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'check',
          '--issues',
          '--package',
          '--help',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );
      const packageHelpPlainStdout = stripAnsi(packageHelpResult.stdout);
      expect(packageHelpResult.stdout).toContain(`${ANSI_ESCAPE}[`);
      expect(packageHelpPlainStdout).toContain('Check issue packages:');
      expect(packageHelpPlainStdout).toContain('- @example/app  1 issue');
      expect(packageHelpPlainStdout).toContain(
        '- @example/pkg-entry  0 issues',
      );

      const checkerHelpResult = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'check',
          '--issues',
          '--checker',
          '--help',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );
      const checkerHelpPlainStdout = stripAnsi(checkerHelpResult.stdout);
      expect(checkerHelpResult.stdout).toContain(`${ANSI_ESCAPE}[`);
      expect(checkerHelpPlainStdout).toContain('Check issue checkers:');
      expect(checkerHelpPlainStdout).toContain('- typescript  1 issue');

      await expect(
        execFileAsync(process.execPath, [cliPath, 'check', 'demo', '--issues']),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          '`limina check --issues` does not accept a pipeline name.',
        ),
      });
      await expect(
        execFileAsync(process.execPath, [
          cliPath,
          'check',
          '--task',
          'proof:check',
        ]),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          '`limina check --task`, `--checker`, and `--format` require --issues.',
        ),
      });
      await Promise.all([
        expect(
          execFileAsync(process.execPath, [
            cliPath,
            'check',
            '--issues',
            '--tool',
            'knip',
          ]),
        ).rejects.toMatchObject({
          stderr: expect.stringContaining('Unknown option `--tool`'),
        }),
        expect(
          execFileAsync(process.execPath, [
            cliPath,
            'check',
            '--issues',
            '--fixes',
          ]),
        ).rejects.toMatchObject({
          stderr: expect.stringContaining('Unknown option `--fixes`'),
        }),
        expect(
          execFileAsync(process.execPath, [
            cliPath,
            'check',
            '--issues',
            '--details',
          ]),
        ).rejects.toMatchObject({
          stderr: expect.stringContaining('Unknown option `--details`'),
        }),
      ]);
      try {
        await execFileAsync(
          process.execPath,
          [
            cliPath,
            '--config',
            path.join(rootDir, 'limina.config.mjs'),
            'check',
            '--issues',
            '--rule',
            'LIMINA_NOT_A_REAL_RULE',
          ],
          {
            cwd: rootDir,
            env: {
              ...process.env,
              CI: 'true',
            },
          },
        );
        throw new Error('Expected unknown rule to fail.');
      } catch (error) {
        const stderr =
          typeof (error as { stderr?: unknown }).stderr === 'string'
            ? (error as { stderr: string }).stderr
            : '';

        expect(stderr).toContain(
          'Unknown check --rule code "LIMINA_NOT_A_REAL_RULE".',
        );
        expect(stderr).toContain(
          'Run `limina check --issues --rule --help` to see supported rule codes.',
        );
        expect(stderr).not.toContain(
          'Expected one of the built-in Limina rule codes',
        );
        expect(stderr).not.toContain('LIMINA_SOURCE_UNUSED_MODULE');
      }
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  }, 90_000);

  it('prints checker filter help from auto checker discovery', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-cli-auto-issues-')),
    );
    const cliPath = fileURLToPath(
      new URL('../../bin/limina.js', import.meta.url),
    );

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages:\n  - app\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `export default ${JSON.stringify(
          {
            config: {
              checkers: {
                mode: 'auto',
              },
            },
          },
          null,
          2,
        )};\n`,
      );
      await writeText(
        path.join(rootDir, 'app/src/index.ts'),
        'export const value = 1;\n',
      );
      await writeText(
        path.join(rootDir, 'app/tsconfig.json'),
        stringifyConfig({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['src/**/*.ts'],
        }),
      );

      const result = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'check',
          '--issues',
          '--checker',
          '--help',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );
      const plainStdout = stripAnsi(result.stdout);

      expect(result.stdout).toContain(`${ANSI_ESCAPE}[`);
      expect(plainStdout).toContain('Check issue checkers:');
      expect(plainStdout).toContain('- typescript  0 issues');
      expect(plainStdout).not.toContain('No check issue snapshot found.');
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  }, 15_000);

  it('runs release check with repeated package filters from the public command', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-cli-release-')),
    );
    const cliPath = fileURLToPath(
      new URL('../../bin/limina.js', import.meta.url),
    );

    async function writePackage(packageName: string): Promise<void> {
      const packageDirName = packageName.split('/').at(-1) ?? packageName;
      const packageDir = path.join(rootDir, 'packages', packageDirName);
      const outDir = path.join(packageDir, 'dist');

      await writeText(
        path.join(packageDir, 'package.json'),
        stringifyConfig({
          name: packageName,
          version: '1.0.0',
        }),
      );
      await writeText(path.join(packageDir, 'src/index.ts'), 'export {};\n');
      await writeText(
        path.join(outDir, 'package.json'),
        stringifyConfig({
          exports: {
            '.': './index.js',
          },
          license: 'MIT',
          name: packageName,
          types: './index.d.ts',
          version: '1.0.0',
        }),
      );
      await writeText(
        path.join(outDir, 'index.js'),
        'export const value = 1;\n',
      );
      await writeText(path.join(outDir, 'README.md'), '# Example package\n');
      await writeText(path.join(outDir, 'LICENSE.md'), 'MIT\n');
    }

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages:\n  - packages/*\n',
      );
      await writePackage('@example/a');
      await writePackage('@example/b');
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `export default ${JSON.stringify(
          {
            package: {
              entries: [
                {
                  name: '@example/a',
                  outDir: 'packages/a/dist',
                },
                {
                  name: '@example/b',
                  outDir: 'packages/b/dist',
                },
              ],
            },
          },
          null,
          2,
        )};\n`,
      );

      const result = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'release',
          'check',
          '--package',
          '@example/a',
          '--package',
          '@example/b',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );

      expect(result.stdout).toContain('limina release check');
      expect(result.stdout).toContain('limina release passed');
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  }, 30_000);

  it('prints standalone graph check verbose issue details from the public command', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-cli-graph-verbose-')),
    );
    const cliPath = fileURLToPath(
      new URL('../../bin/limina.js', import.meta.url),
    );

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages:\n  - packages/*\n',
      );
      await writeText(
        path.join(rootDir, 'package.json'),
        stringifyConfig({
          name: 'root',
          private: true,
        }),
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `export default ${JSON.stringify(
          {
            config: {
              checkers: {
                typescript: {
                  include: ['packages/**/tsconfig.json'],
                  preset: 'tsc',
                },
              },
            },
          },
          null,
          2,
        )};\n`,
      );
      await writeText(
        path.join(rootDir, 'packages/a/package.json'),
        stringifyConfig({
          dependencies: {
            '@example/b': 'workspace:*',
          },
          name: '@example/a',
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/a/src/index.ts'),
        "import { value } from '@example/b';\nexport const appValue = value;\n",
      );
      await writeText(
        path.join(rootDir, 'packages/a/tsconfig.lib.json'),
        stringifyConfig({
          compilerOptions: {
            ...buildCompilerOptions,
            noEmit: true,
          },
          include: ['src/**/*.ts'],
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/a/tsconfig.json'),
        stringifyConfig({
          files: [],
          references: [{ path: './tsconfig.lib.json' }],
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/b/package.json'),
        stringifyConfig({
          exports: {
            '.': './src/index.ts',
          },
          name: '@example/b',
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/b/src/index.ts'),
        'export const value = 1;\n',
      );
      await writeText(
        path.join(rootDir, 'packages/b/tsconfig.lib.json'),
        stringifyConfig({
          compilerOptions: {
            ...buildCompilerOptions,
            noEmit: true,
          },
          include: ['src/**/*.ts'],
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/b/tsconfig.json'),
        stringifyConfig({
          files: [],
          references: [{ path: './tsconfig.lib.json' }],
        }),
      );

      const result = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'graph',
          'check',
          '--verbose',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      ).then(
        ({ stderr, stdout }) => ({
          code: 0,
          output: `${stdout}${stderr}`,
        }),
        (error: { code?: number; stderr?: string; stdout?: string }) => ({
          code: error.code,
          output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
        }),
      );

      expect(result.code).toBe(1);
      expect(result.output).toContain('Graph check summary');
      expect(result.output).toContain('details:');
      expect(result.output).toContain('Missing project reference');
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  }, 30_000);

  it('exports the dependency graph to stdout from the public command', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-cli-graph-export-')),
    );
    const cliPath = fileURLToPath(
      new URL('../../bin/limina.js', import.meta.url),
    );

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages:\n  - packages/*\n',
      );
      await writeText(
        path.join(rootDir, 'package.json'),
        stringifyConfig({
          name: 'root',
          private: true,
        }),
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `export default ${JSON.stringify(
          {
            config: {
              checkers: {
                typescript: {
                  include: ['packages/**/tsconfig.json'],
                  preset: 'tsc',
                },
              },
            },
          },
          null,
          2,
        )};\n`,
      );
      await writeText(
        path.join(rootDir, 'packages/a/package.json'),
        stringifyConfig({
          dependencies: {
            '@example/b': 'workspace:*',
          },
          name: '@example/a',
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/a/src/index.ts'),
        "import { value } from '@example/b';\nexport const appValue = value;\n",
      );
      await writeText(
        path.join(rootDir, 'packages/a/tsconfig.lib.json'),
        stringifyConfig({
          compilerOptions: {
            ...buildCompilerOptions,
            noEmit: true,
          },
          include: ['src/**/*.ts'],
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/a/tsconfig.json'),
        stringifyConfig({
          files: [],
          references: [{ path: './tsconfig.lib.json' }],
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/b/package.json'),
        stringifyConfig({
          exports: {
            '.': './src/index.ts',
          },
          name: '@example/b',
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/b/src/index.ts'),
        'export const value = 1;\n',
      );
      await writeText(
        path.join(rootDir, 'packages/b/tsconfig.lib.json'),
        stringifyConfig({
          compilerOptions: {
            ...buildCompilerOptions,
            noEmit: true,
          },
          include: ['src/**/*.ts'],
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/b/tsconfig.json'),
        stringifyConfig({
          files: [],
          references: [{ path: './tsconfig.lib.json' }],
        }),
      );

      const result = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'graph',
          'export',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );

      const graph = JSON.parse(result.stdout) as {
        edges: { from: string; kind: string; to: string }[];
      };

      expect(graph.edges).toEqual([
        {
          evidence: [
            {
              importer: 'packages/a/src/index.ts',
              resolvedPath: 'packages/b/src/index.ts',
              specifier: '@example/b',
            },
          ],
          from: 'pkg:@example/a',
          kind: 'source',
          to: 'pkg:@example/b',
        },
      ]);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  }, 15_000);

  it('runs graph prepare from the public command', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-cli-graph-prepare-')),
    );
    const cliPath = fileURLToPath(
      new URL('../../bin/limina.js', import.meta.url),
    );

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages:\n  - app\n',
      );
      await writeText(
        path.join(rootDir, 'package.json'),
        stringifyConfig({
          name: 'root',
          private: true,
        }),
      );
      await writeText(
        path.join(rootDir, 'app/package.json'),
        stringifyConfig({
          name: 'app',
          private: true,
        }),
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `export default ${JSON.stringify(
          {
            config: {
              checkers: {
                typescript: {
                  include: ['app/tsconfig.json'],
                  preset: 'tsc',
                },
              },
            },
          },
          null,
          2,
        )};\n`,
      );
      await writeText(
        path.join(rootDir, 'app/node.ts'),
        'export const nodeValue = 1;\n',
      );
      await writeText(
        path.join(rootDir, 'app/runtime.ts'),
        "import { nodeValue } from './node';\nexport const runtimeValue = nodeValue;\n",
      );
      await writeText(
        path.join(rootDir, 'app/tsconfig.node.json'),
        stringifyConfig({
          compilerOptions: buildCompilerOptions,
          include: ['node.ts'],
        }),
      );
      await writeText(
        path.join(rootDir, 'app/tsconfig.runtime.json'),
        stringifyConfig({
          compilerOptions: buildCompilerOptions,
          include: ['runtime.ts'],
        }),
      );
      await writeText(
        path.join(rootDir, 'app/tsconfig.json'),
        stringifyConfig({
          files: [],
          references: [
            {
              path: './tsconfig.node.json',
            },
            {
              path: './tsconfig.runtime.json',
            },
          ],
        }),
      );

      const result = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'graph',
          'prepare',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );

      expect(result.stdout).toContain('limina graph prepare');
      expect(result.stdout).toContain('limina graph passed');
      expect(
        await readFile(
          path.join(
            rootDir,
            '.limina/tsconfig/checkers/typescript/projects/app/tsconfig.runtime.dts.json',
          ),
          'utf8',
        ),
      ).toContain('"path": "./tsconfig.node.dts.json"');
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  }, 15_000);

  it('exports an artifact dependency graph to an output file', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-cli-graph-export-output-')),
    );
    const cliPath = fileURLToPath(
      new URL('../../bin/limina.js', import.meta.url),
    );

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages:\n  - packages/*\n',
      );
      await writeText(
        path.join(rootDir, 'package.json'),
        stringifyConfig({
          name: 'root',
          private: true,
        }),
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `export default ${JSON.stringify(
          {
            config: {
              checkers: {
                typescript: {
                  include: ['packages/**/tsconfig.json'],
                  preset: 'tsc',
                },
              },
            },
          },
          null,
          2,
        )};\n`,
      );
      await writeText(
        path.join(rootDir, 'packages/a/package.json'),
        stringifyConfig({
          dependencies: {
            '@example/b': 'workspace:*',
          },
          name: '@example/a',
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/a/src/index.ts'),
        "import { runtimeValue } from '@example/b/runtime';\nexport const value = runtimeValue;\n",
      );
      await writeText(
        path.join(rootDir, 'packages/a/tsconfig.lib.json'),
        stringifyConfig({
          compilerOptions: {
            ...buildCompilerOptions,
            noEmit: true,
          },
          include: ['src/**/*.ts'],
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/a/tsconfig.json'),
        stringifyConfig({
          files: [],
          references: [{ path: './tsconfig.lib.json' }],
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/b/package.json'),
        stringifyConfig({
          exports: {
            './runtime': {
              default: './dist/runtime.js',
              types: './dist/runtime.d.ts',
            },
          },
          name: '@example/b',
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/b/dist/runtime.d.ts'),
        'export declare const runtimeValue = 1;\n',
      );
      await writeText(
        path.join(rootDir, 'packages/b/dist/runtime.js'),
        'export const runtimeValue = 1;\n',
      );
      await writeText(
        path.join(rootDir, 'packages/b/src/index.ts'),
        'export const sourceValue = 1;\n',
      );
      await writeText(
        path.join(rootDir, 'packages/b/tsconfig.lib.json'),
        stringifyConfig({
          compilerOptions: {
            ...buildCompilerOptions,
            noEmit: true,
          },
          include: ['src/**/*.ts'],
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/b/tsconfig.json'),
        stringifyConfig({
          files: [],
          references: [{ path: './tsconfig.lib.json' }],
        }),
      );

      const result = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'limina.config.mjs'),
          'graph',
          'export',
          '--view',
          'artifact',
          '--output',
          'dependency-graph.json',
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );
      const graph = JSON.parse(
        await readFile(path.join(rootDir, 'dependency-graph.json'), 'utf8'),
      ) as { edges: { kind: string }[]; view: string };

      expect(result.stdout).toBe('');
      expect(graph.view).toBe('artifact');
      expect(graph.edges.map((edge) => edge.kind)).toEqual(['artifact']);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  }, 15_000);

  it('rejects the removed task orchestrator command from the public command', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-cli-nx-generate-')),
    );
    const cliPath = fileURLToPath(
      new URL('../../bin/limina.js', import.meta.url),
    );

    try {
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        'export default {};\n',
      );

      await expect(
        execFileAsync(
          process.execPath,
          [cliPath, '--config', path.join(rootDir, 'limina.config.mjs'), 'nx'],
          {
            cwd: rootDir,
            env: {
              ...process.env,
              CI: 'true',
            },
          },
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('Unknown command "nx".'),
      });
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  }, 15_000);

  it('rejects removed paths commands from the public command', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-cli-paths-')),
    );
    const cliPath = fileURLToPath(
      new URL('../../bin/limina.js', import.meta.url),
    );

    try {
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        'export default {};\n',
      );

      await expect(
        execFileAsync(
          process.execPath,
          [
            cliPath,
            '--config',
            path.join(rootDir, 'limina.config.mjs'),
            'paths',
            'check',
          ],
          {
            cwd: rootDir,
            env: {
              ...process.env,
              CI: 'true',
            },
          },
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('Unknown command'),
      });
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  }, 15_000);

  it('runs init from the public command', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-cli-init-')),
    );
    const cliPath = fileURLToPath(
      new URL('../../bin/limina.js', import.meta.url),
    );

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages:\n  - packages/*\n',
      );
      await writeText(
        path.join(rootDir, 'package.json'),
        stringifyConfig({
          name: 'root',
          private: true,
          type: 'module',
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/app/package.json'),
        stringifyConfig({
          name: 'app',
          type: 'module',
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/app/src/index.ts'),
        'export const value = 1;\n',
      );
      await writeText(
        path.join(rootDir, 'packages/app/tsconfig.json'),
        stringifyConfig({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            target: 'ES2023',
            types: [],
          },
          include: ['src/**/*.ts'],
        }),
      );

      const result = await execFileAsync(
        process.execPath,
        [cliPath, 'init', '--yes'],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
          },
        },
      );
      const stdout = stripAnsi(result.stdout);

      expect(stdout).not.toContain('limina init');
      expect(stdout).not.toContain('limina init finished');
      expect(stdout).not.toContain('[start]');
      expect(
        await readFile(path.join(rootDir, 'limina.config.ts'), 'utf8'),
      ).toContain("mode: 'auto'");
      expect(
        await readFile(path.join(rootDir, 'limina.config.ts'), 'utf8'),
      ).toContain('exclude: []');
      expect(
        await readFile(path.join(rootDir, 'limina.config.ts'), 'utf8'),
      ).not.toContain('include:');
      expect(
        await readFile(path.join(rootDir, '.gitignore'), 'utf8'),
      ).toContain('.limina/');
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  }, 30_000);
});
