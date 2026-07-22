import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { createLiminaCli, runCheckWithCliFlowCleanup } from '../cli';

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

const PUBLIC_CHECK_ISSUE_TASKS = [
  'checker:build',
  'checker:typecheck',
  'command',
  'graph:check',
  'graph:materialize',
  'graph:prepare',
  'package:check',
  'proof:check',
  'release:check',
  'source:check',
  'workspace:validate',
] as const;

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

async function runCliExpectFailure(options: {
  args: string[];
  cliPath: string;
  rootDir: string;
}): Promise<string> {
  try {
    await execFileAsync(
      process.execPath,
      [
        options.cliPath,
        '--config',
        path.join(options.rootDir, 'limina.config.mjs'),
        ...options.args,
      ],
      {
        cwd: options.rootDir,
        env: { ...process.env, CI: 'true' },
      },
    );
  } catch (error) {
    const result = error as {
      code?: unknown;
      stderr?: unknown;
      stdout?: unknown;
    };
    expect(result.code).not.toBe(0);
    return stripAnsi(
      `${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`,
    );
  }
  throw new Error('Expected Limina CLI command to fail.');
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
  it('closes the check flow without replacing a primary infrastructure error', async () => {
    const primaryError = new Error('snapshot writer failed');
    const closeError = new Error('flow close failed');
    const outro = vi.fn();
    const close = vi.fn().mockRejectedValue(closeError);

    await expect(
      runCheckWithCliFlowCleanup({ close, outro }, async () => {
        throw primaryError;
      }),
    ).rejects.toBe(primaryError);

    expect(outro).toHaveBeenCalledWith('limina check failed');
    expect(close).toHaveBeenCalledOnce();
    expect(
      (primaryError as Error & { flowCloseError?: unknown }).flowCloseError,
    ).toBe(closeError);
  });

  it('propagates a check flow close error when execution succeeded', async () => {
    const closeError = new Error('flow close failed');
    const outro = vi.fn();
    const close = vi.fn().mockRejectedValue(closeError);

    await expect(
      runCheckWithCliFlowCleanup({ close, outro }, async () => true),
    ).rejects.toBe(closeError);

    expect(outro).toHaveBeenCalledWith('limina check passed');
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes the check flow and reports a snapshot writer error once', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-cli-writer-failure-')),
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
        stringifyConfig({ name: 'root', private: true }),
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `export default ${JSON.stringify({
          pipelines: {
            demo: [
              {
                args: ['-e', 'process.exit(0)'],
                command: process.execPath,
                type: 'command',
              },
            ],
          },
        })};\n`,
      );
      await mkdir(path.join(rootDir, '.limina/check/last-run.json'), {
        recursive: true,
      });

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
            'demo',
          ],
          {
            cwd: rootDir,
            env: { ...process.env, CI: 'true' },
          },
        );
        throw new Error('Expected snapshot writer failure.');
      } catch (error) {
        expect(error).toMatchObject({ code: 1 });
        stdout = String((error as { stdout?: unknown }).stdout ?? '');
        stderr = String((error as { stderr?: unknown }).stderr ?? '');
      }

      const output = stripAnsi(`${stdout}\n${stderr}`);
      expect(output).toContain('limina check failed');
      expect(output.match(/limina failed:/gu)).toHaveLength(1);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  }, 15_000);

  it('rejects an empty named pipeline before flow and snapshot creation', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-cli-empty-pipeline-')),
    );
    const cliPath = fileURLToPath(
      new URL('../../bin/limina.js', import.meta.url),
    );
    const snapshotPath = path.join(rootDir, '.limina/check/last-run.json');
    const previousSnapshot = '{"sentinel":"unchanged"}\n';

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'package.json'),
        stringifyConfig({ name: 'root', private: true }),
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        'export default { pipelines: { demo: [] } };\n',
      );
      await writeText(snapshotPath, previousSnapshot);

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
            'demo',
          ],
          {
            cwd: rootDir,
            env: { ...process.env, CI: 'true' },
          },
        );
        throw new Error('Expected empty pipeline planning failure.');
      } catch (error) {
        expect(error).toMatchObject({ code: 1 });
        stdout = String((error as { stdout?: unknown }).stdout ?? '');
        stderr = String((error as { stderr?: unknown }).stderr ?? '');
      }

      const output = stripAnsi(`${stdout}\n${stderr}`);
      expect(output).toContain(
        'Pipeline "demo" must contain at least one step.',
      );
      expect(output).not.toContain('limina check failed');
      expect(await readFile(snapshotPath, 'utf8')).toBe(previousSnapshot);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  }, 15_000);

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

  it('keeps standalone failures queryable without replacing the last check', async () => {
    await withCliBuildFixture(async ({ cliPath, rootDir }) => {
      const configPath = path.join(rootDir, 'limina config.mjs');
      const explicitConfigArgument = path.join(
        'packages',
        '..',
        'limina config.mjs',
      );
      const lastRunPath = path.join(rootDir, '.limina/check/last-run.json');
      const otherCwd = await mkdtemp(
        path.join(tmpdir(), 'limina-invocation-query-'),
      );

      try {
        await writeText(
          configPath,
          await readFile(path.join(rootDir, 'limina.config.mjs'), 'utf8'),
        );
        await writeText(
          lastRunPath,
          stringifyConfig({
            command: 'limina check',
            createdAt: '2026-07-17T00:00:00.000Z',
            issues: [
              {
                code: 'LIMINA_PROOF_UNCOVERED_SOURCE_FILE',
                id: 'seed-check-issue',
                reason: 'seed issue',
                task: 'proof:check',
                title: 'Seed check issue',
              },
            ],
            status: 'completed',
            version: 7,
          }),
        );
        const seedSnapshot = await readFile(lastRunPath, 'utf8');

        await execFileAsync(
          process.execPath,
          [cliPath, '--config', configPath, 'checker', 'build'],
          {
            cwd: rootDir,
            env: { ...process.env, CI: 'true' },
          },
        );
        expect(await readFile(lastRunPath, 'utf8')).toBe(seedSnapshot);

        await writeText(
          configPath,
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
              package: {
                entries: [
                  {
                    checks: ['boundary'],
                    name: '@example/boundary',
                    outDir: 'packages/boundary/dist',
                  },
                  {
                    name: '@example/release',
                    outDir: 'packages/release-missing/dist',
                  },
                ],
              },
            },
            null,
            2,
          )};\n`,
        );
        await writeText(
          path.join(rootDir, 'packages/pkg/package.json'),
          stringifyConfig({
            dependencies: { '@example/b': 'workspace:*' },
            name: '@example/a',
          }),
        );
        await writeText(
          path.join(rootDir, 'packages/pkg/src/index.ts'),
          "import { value } from '@example/b';\nexport const appValue = value;\n",
        );
        await writeText(
          path.join(rootDir, 'packages/b/package.json'),
          stringifyConfig({
            exports: { '.': './src/index.ts' },
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
        await writeText(
          path.join(rootDir, 'packages/boundary/dist/package.json'),
          stringifyConfig({
            exports: { '.': './browser/index.js' },
            name: '@example/boundary',
            version: '1.0.0',
          }),
        );
        await writeText(
          path.join(rootDir, 'packages/boundary/dist/browser/index.js'),
          "import '@example/undeclared';\n",
        );

        const runFailure = async (
          args: string[],
          expectedTask: string,
          options: {
            configArgument?: string;
            expectedConfigPath: string;
          } = {
            configArgument: explicitConfigArgument,
            expectedConfigPath: configPath,
          },
        ): Promise<void> => {
          const mode = 'standalone invocation mode';
          let stdout = '';

          try {
            await execFileAsync(
              process.execPath,
              [
                cliPath,
                ...(options.configArgument === undefined
                  ? []
                  : ['--config', options.configArgument]),
                '--config-loader',
                'native',
                '--mode',
                mode,
                ...args,
              ],
              {
                cwd: rootDir,
                env: { ...process.env, CI: 'true' },
              },
            );
            throw new Error(`Expected ${args.join(' ')} to fail.`);
          } catch (error) {
            expect(error).toMatchObject({ code: 1 });
            stdout = String((error as { stdout?: unknown }).stdout ?? '');
          }

          const invocationId =
            /Standalone issue invocation: ([0-9a-f-]+)/u.exec(stdout)?.[1];
          const outputLines = stdout.split('\n');
          const queryLines =
            process.platform === 'win32'
              ? [
                  outputLines.find((line) => line.startsWith('PowerShell: ')),
                  outputLines.find((line) =>
                    line.startsWith('cmd.exe (/V:OFF): '),
                  ),
                ]
              : [outputLines.find((line) => line.startsWith('Query: '))];

          expect(invocationId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
          );
          expect(queryLines).not.toContain(undefined);
          // The PowerShell variant marshals the canonical Node argv through a
          // Base64 JSON transport token, so flags like `--config` are not
          // present as plaintext on that line. Decode any trailing Base64
          // payload back into its arguments before asserting on the tokens.
          const expandQueryLine = (line: string): string => {
            const base64Match = /'([A-Za-z0-9+/=]{16,})'\s*$/u.exec(line);
            if (!base64Match) {
              return line;
            }
            const decodedArgs = JSON.parse(
              Buffer.from(base64Match[1], 'base64').toString('utf8'),
            ) as string[];
            return `${line} ${decodedArgs.join(' ')}`;
          };
          for (const queryLine of queryLines) {
            const queryTokens = expandQueryLine(queryLine!);
            expect(queryTokens).toContain(rootDir.replaceAll(path.sep, '/'));
            expect(queryTokens).toContain('--config');
            expect(queryTokens).toContain(
              options.expectedConfigPath.replaceAll(path.sep, '/'),
            );
            expect(queryTokens).toContain('--config-loader');
            expect(queryTokens).toContain('native');
            expect(queryTokens).toContain('--mode');
            expect(queryTokens).toContain(mode);
            expect(queryTokens).toContain('--invocation');
            expect(queryTokens).toContain(invocationId);
          }
          if (process.platform === 'win32') {
            expect(queryLines[0]).toContain('Set-Location -LiteralPath');
            expect(queryLines[0]).toContain('-ErrorAction Stop; &');
            expect(queryLines[0]).toContain('node');
            expect(queryLines[0]).not.toContain('pnpm');
            expect(queryLines[1]).toContain('cd /d');
            expect(queryLines[1]).toContain('node');
            expect(queryLines[1]).not.toContain('pnpm');
          } else {
            expect(queryLines[0]).toContain('pnpm');
            expect(queryLines[0]).toContain('--dir');
          }

          const query = await execFileAsync(
            process.execPath,
            [
              cliPath,
              '--config',
              options.expectedConfigPath,
              'check',
              '--issues',
              '--invocation',
              invocationId!,
              '--format',
              'json',
            ],
            {
              cwd: otherCwd,
              env: { ...process.env, CI: 'true' },
            },
          );
          const payload = JSON.parse(query.stdout) as {
            invocationId: string;
            issueCount: number;
            issues: {
              code: string;
              filePath?: string;
              reason: string;
              task: string;
            }[];
            kind: string;
            result: string;
            version: number;
          };

          expect(payload).toMatchObject({
            invocationId,
            kind: 'standalone-invocation',
            result: 'failed',
            version: 1,
          });
          expect(payload.issueCount).toBeGreaterThan(0);
          expect(payload.issues).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                code: expect.any(String),
                filePath: expect.any(String),
                reason: expect.any(String),
                task: expectedTask,
              }),
            ]),
          );
          expect(await readFile(lastRunPath, 'utf8')).toBe(seedSnapshot);
        };

        await runFailure(
          ['checker', 'build', 'packages/missing/tsconfig.json'],
          'checker:build',
          {
            expectedConfigPath: path.join(rootDir, 'limina.config.mjs'),
          },
        );
        await runFailure(
          ['checker', 'build', 'packages/missing/tsconfig.json'],
          'checker:build',
        );
        await runFailure(['graph', 'check'], 'graph:check');
        await runFailure(['proof', 'check'], 'proof:check');
        await runFailure(
          [
            'package',
            'check',
            '--package',
            '@example/boundary',
            '--tool',
            'boundary',
          ],
          'package:check',
        );
        await runFailure(
          ['release', 'check', '--package', '@example/release'],
          'release:check',
        );
      } finally {
        await rm(otherCwd, { force: true, recursive: true });
      }
    });
  }, 60_000);

  it('keeps the last completed check when a running check is terminated', async () => {
    await withCliBuildFixture(async ({ cliPath, rootDir }) => {
      const barrierScript = path.join(rootDir, 'slow-check.cjs');
      const configPath = path.join(rootDir, 'limina.config.mjs');
      const markerPath = path.join(rootDir, 'slow-check.started');
      const lastRunPath = path.join(rootDir, '.limina/check/last-run.json');
      let checkProcessPid: number | undefined;
      let commandPid: number | undefined;

      await writeText(
        barrierScript,
        [
          "const { writeFileSync } = require('node:fs');",
          'const markerPath = process.argv[2];',
          'if (!markerPath) process.exit(98);',
          'writeFileSync(markerPath, JSON.stringify({ commandPid: process.pid, parentPid: process.ppid }));',
          'setInterval(() => {}, 1000);',
          '',
        ].join('\n'),
      );
      await writeText(
        configPath,
        `export default ${JSON.stringify({
          pipelines: {
            slow: [
              {
                args: [barrierScript, markerPath],
                command: process.execPath,
                type: 'command',
              },
            ],
          },
        })};\n`,
      );
      await writeText(
        lastRunPath,
        stringifyConfig({
          command: 'limina check',
          createdAt: '2026-07-17T00:00:00.000Z',
          issues: [
            {
              code: 'LIMINA_PROOF_UNCOVERED_SOURCE_FILE',
              id: 'completed-check-a',
              reason: 'completed check A',
              task: 'proof:check',
              title: 'Completed check A',
            },
          ],
          status: 'completed',
          version: 7,
        }),
      );
      const completedCheck = await readFile(lastRunPath, 'utf8');
      const child = spawn(process.execPath, [cliPath, 'check', 'slow'], {
        cwd: rootDir,
        env: { ...process.env, CI: 'true' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.resume();
      child.stderr.resume();
      const closed = new Promise<void>((resolve) => {
        child.once('close', () => resolve());
        child.once('error', () => resolve());
      });

      try {
        await vi.waitFor(
          () => {
            expect(existsSync(markerPath)).toBe(true);
          },
          { timeout: 10_000 },
        );
        const processInfo = JSON.parse(await readFile(markerPath, 'utf8')) as {
          commandPid: number;
          parentPid: number;
        };
        checkProcessPid = processInfo.parentPid;
        commandPid = processInfo.commandPid;
        expect(() => process.kill(checkProcessPid!, 'SIGKILL')).not.toThrow();
        if (Number.isInteger(commandPid)) {
          try {
            process.kill(commandPid, 'SIGKILL');
          } catch {
            // The command child may exit when its Limina parent is terminated.
          }
        }
        await closed;

        expect(await readFile(lastRunPath, 'utf8')).toBe(completedCheck);
        const query = await execFileAsync(
          process.execPath,
          [cliPath, 'check', '--issues', '--format', 'json'],
          {
            cwd: rootDir,
            env: { ...process.env, CI: 'true' },
          },
        );
        expect(JSON.parse(query.stdout)).toMatchObject({
          issueCount: 1,
          issues: [{ id: 'completed-check-a' }],
        });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await closed;
        }
        if (checkProcessPid && Number.isInteger(checkProcessPid)) {
          try {
            process.kill(checkProcessPid, 'SIGKILL');
          } catch {
            // The check process was expected to be terminated above.
          }
        }
        if (commandPid && Number.isInteger(commandPid)) {
          try {
            process.kill(commandPid, 'SIGKILL');
          } catch {
            // The command child may already have exited with its Limina parent.
          }
        }
      }
    });
  }, 30_000);

  it('keeps concurrent checker failure invocations isolated', async () => {
    await withCliBuildFixture(async ({ cliPath, rootDir }) => {
      const barrierDir = path.join(rootDir, 'barrier');
      const configPath = path.join(rootDir, 'limina.config.mjs');
      const lastRunPath = path.join(rootDir, '.limina/check/last-run.json');

      await writeText(
        path.join(rootDir, 'packages/b/src/index.ts'),
        'export const value = 2;\n',
      );
      await writeText(
        path.join(rootDir, 'packages/b/tsconfig.lib.json'),
        stringifyConfig({
          liminaOptions: { outputs: {} },
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
      await writeText(
        configPath,
        `export default ${JSON.stringify(
          {
            config: {
              checkers: {
                typescript: {
                  include: ['packages/*/tsconfig.json'],
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
          "const { existsSync, mkdirSync, writeFileSync } = require('node:fs');",
          "const { join } = require('node:path');",
          'const barrierDir = process.env.LIMINA_TEST_BARRIER_DIR;',
          "if (!barrierDir) throw new Error('missing barrier dir');",
          'mkdirSync(barrierDir, { recursive: true });',
          "const args = process.argv.slice(2).join(' ').replaceAll('\\\\', '/');",
          "const name = args.includes('/packages/pkg/') ? 'pkg' : 'b';",
          'writeFileSync(join(barrierDir, name), args);',
          'const deadline = Date.now() + 10000;',
          'const timer = setInterval(() => {',
          "  if (existsSync(join(barrierDir, 'pkg')) && existsSync(join(barrierDir, 'b'))) {",
          '    clearInterval(timer);',
          "    process.exit(name === 'pkg' ? 7 : 8);",
          '  }',
          '  if (Date.now() > deadline) {',
          '    clearInterval(timer);',
          '    process.exit(99);',
          '  }',
          '}, 10);',
          '',
        ].join('\n'),
      );
      await writeText(
        lastRunPath,
        stringifyConfig({
          command: 'limina check',
          createdAt: '2026-07-17T00:00:00.000Z',
          issues: [],
          status: 'completed',
          version: 7,
        }),
      );
      const seedSnapshot = await readFile(lastRunPath, 'utf8');

      const runChecker = async (config: string) =>
        execFileAsync(
          process.execPath,
          [cliPath, '--config', configPath, 'checker', 'build', config],
          {
            cwd: rootDir,
            env: {
              ...process.env,
              CI: 'true',
              LIMINA_TEST_BARRIER_DIR: barrierDir,
            },
          },
        ).then(
          () => {
            throw new Error(`Expected checker build ${config} to fail.`);
          },
          (error: { code?: number; stdout?: string }) => error,
        );
      const [pkgResult, bResult] = await Promise.all([
        runChecker('packages/pkg/tsconfig.lib.json'),
        runChecker('packages/b/tsconfig.lib.json'),
      ]);

      expect(pkgResult.code).toBe(1);
      expect(bResult.code).toBe(1);
      const invocationIds = [pkgResult, bResult].map(
        (result) =>
          /Standalone issue invocation: ([0-9a-f-]+)/u.exec(
            result.stdout ?? '',
          )?.[1],
      );

      expect(invocationIds[0]).toBeTruthy();
      expect(invocationIds[1]).toBeTruthy();
      expect(invocationIds[0]).not.toBe(invocationIds[1]);

      const payloads = await Promise.all(
        invocationIds.map(async (invocationId) => {
          const query = await execFileAsync(
            process.execPath,
            [
              cliPath,
              '--config',
              configPath,
              'check',
              '--issues',
              '--invocation',
              invocationId!,
              '--format',
              'json',
            ],
            {
              cwd: rootDir,
              env: { ...process.env, CI: 'true' },
            },
          );
          return JSON.parse(query.stdout) as {
            issueCount: number;
            issues: { filePath?: string; id?: string }[];
          };
        }),
      );

      expect(payloads[0]).toMatchObject({ issueCount: 1 });
      expect(payloads[1]).toMatchObject({ issueCount: 1 });
      expect(payloads[0]!.issues[0]?.filePath).toContain('packages/pkg');
      expect(payloads[1]!.issues[0]?.filePath).toContain('packages/b');
      expect(payloads[0]!.issues[0]?.id).not.toBe(payloads[1]!.issues[0]?.id);
      expect(await readFile(lastRunPath, 'utf8')).toBe(seedSnapshot);
    });
  }, 45_000);

  it('prints only the current check result when two checks finish concurrently', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-concurrent-checks-')),
    );
    const cliPath = fileURLToPath(
      new URL('../../bin/limina.js', import.meta.url),
    );
    const barrierScript = path.join(rootDir, 'check-barrier.cjs');
    const barrierDir = path.join(rootDir, 'barrier');

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages:\n  - packages/*\n',
      );
      await writeText(
        path.join(rootDir, 'package.json'),
        stringifyConfig({ name: 'root', private: true }),
      );
      await writeText(
        barrierScript,
        [
          "const { existsSync, mkdirSync, writeFileSync } = require('node:fs');",
          "const { join } = require('node:path');",
          'const [name, barrierDir] = process.argv.slice(2);',
          'const run = process.env.LIMINA_TEST_RUN;',
          'if (!name || !barrierDir || !run) process.exit(98);',
          'mkdirSync(barrierDir, { recursive: true });',
          'writeFileSync(join(barrierDir, `${run}-${name}`), name);',
          'const deadline = Date.now() + 10000;',
          'const timer = setInterval(() => {',
          "  const ready = ['ALPHA_RESULT', 'BETA_RESULT'].every((item) => existsSync(join(barrierDir, `${run}-${item}`)));",
          '  if (ready) {',
          '    clearInterval(timer);',
          "    process.exit(name === 'ALPHA_RESULT' ? 7 : 8);",
          '  }',
          '  if (Date.now() > deadline) {',
          '    clearInterval(timer);',
          '    process.exit(99);',
          '  }',
          '}, 10);',
          '',
        ].join('\n'),
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `export default ${JSON.stringify({
          pipelines: {
            alpha: [
              {
                args: [barrierScript, 'ALPHA_RESULT', barrierDir],
                command: process.execPath,
                type: 'command',
              },
            ],
            beta: [
              {
                args: [barrierScript, 'BETA_RESULT', barrierDir],
                command: process.execPath,
                type: 'command',
              },
            ],
          },
        })};\n`,
      );

      const runCheck = (pipeline: 'alpha' | 'beta', run: string) =>
        execFileAsync(process.execPath, [cliPath, 'check', pipeline], {
          cwd: rootDir,
          env: {
            ...process.env,
            CI: 'true',
            LIMINA_TEST_RUN: run,
          },
        }).then(
          () => {
            throw new Error(`Expected check ${pipeline} to fail.`);
          },
          (error: { code?: number; stdout?: string }) => error,
        );

      for (let iteration = 0; iteration < 3; iteration += 1) {
        const run = `run-${iteration}`;
        const [alpha, beta] = await Promise.all([
          runCheck('alpha', run),
          runCheck('beta', run),
        ]);
        const alphaOutput = stripAnsi(alpha.stdout ?? '');
        const betaOutput = stripAnsi(beta.stdout ?? '');
        const alphaSummary = alphaOutput.slice(
          alphaOutput.lastIndexOf('Limina check summary'),
        );
        const betaSummary = betaOutput.slice(
          betaOutput.lastIndexOf('Limina check summary'),
        );

        expect(alpha.code).toBe(1);
        expect(beta.code).toBe(1);
        expect(alphaSummary).toContain('ALPHA_RESULT');
        expect(alphaSummary).not.toContain('BETA_RESULT');
        expect(alphaSummary).toContain(
          'limina check --issues --task command --verbose',
        );
        expect(betaSummary).toContain('BETA_RESULT');
        expect(betaSummary).not.toContain('ALPHA_RESULT');
        expect(betaSummary).toContain(
          'limina check --issues --task command --verbose',
        );
      }

      const stableTaskQuery = await execFileAsync(
        process.execPath,
        [cliPath, 'check', '--issues', '--task', 'command', '--format', 'json'],
        {
          cwd: rootDir,
          env: { ...process.env, CI: 'true' },
        },
      );
      expect(JSON.parse(stableTaskQuery.stdout)).toMatchObject({
        issueCount: 1,
        issues: [{ task: 'command' }],
      });
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  }, 45_000);

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

  it('rejects rootDir-escaping effective emit paths before public managed build spawn', async () => {
    await withCliBuildFixture(async ({ cliPath, rootDir }) => {
      const externalMarker = path.join(rootDir, 'external/marker.txt');
      await writeText(externalMarker, 'external marker bytes\n');
      await writeText(
        path.join(rootDir, 'packages/pkg/outside.ts'),
        'export const outside = 1;\n',
      );
      await writeText(
        path.join(rootDir, 'packages/pkg/tsconfig.lib.json'),
        stringifyConfig({
          compilerOptions: {
            ...buildCompilerOptions,
            declarationMap: true,
            noEmit: true,
            sourceMap: true,
          },
          files: ['src/index.ts', 'outside.ts'],
          liminaOptions: {
            outputs: { outDir: './dist', rootDir: './src' },
          },
        }),
      );

      const output = await runCliExpectFailure({
        args: ['build', 'packages/pkg/tsconfig.lib.json'],
        cliPath,
        rootDir,
      });

      expect(output).toContain('outside its authenticated authority');
      await expect(
        readFile(path.join(rootDir, 'tsc-args.txt')),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
      for (const fileName of [
        'outside.js',
        'outside.js.map',
        'outside.d.ts',
        'outside.d.ts.map',
      ]) {
        await expect(
          lstat(path.join(rootDir, 'packages/pkg', fileName)),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      }
      await expect(
        lstat(path.join(rootDir, 'packages/pkg/dist')),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readFile(externalMarker, 'utf8')).resolves.toBe(
        'external marker bytes\n',
      );
    });
  });

  it.each([
    ['managed output build', ['build', 'packages/pkg/tsconfig.lib.json']],
    [
      'selected checker build',
      ['checker', 'build', 'packages/pkg/tsconfig.lib.json'],
    ],
    ['global checker build', ['checker', 'build']],
  ])('rejects inherited outFile before %s spawn', async (_label, args) => {
    await withCliBuildFixture(async ({ cliPath, rootDir }) => {
      const externalMarker = path.join(rootDir, 'external/marker.txt');
      const bundlePath = path.join(rootDir, 'external/bundle.js');
      await writeText(externalMarker, 'external marker bytes\n');
      await writeText(
        path.join(rootDir, 'packages/pkg/tsconfig.base.json'),
        stringifyConfig({
          compilerOptions: { outFile: bundlePath },
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/pkg/tsconfig.lib.json'),
        stringifyConfig({
          compilerOptions: {
            ...buildCompilerOptions,
            noEmit: true,
          },
          extends: './tsconfig.base.json',
          include: ['src/**/*.ts'],
          liminaOptions: { outputs: {} },
        }),
      );

      const output = await runCliExpectFailure({ args, cliPath, rootDir });

      expect(output).toContain('outFile');
      await expect(
        readFile(path.join(rootDir, 'tsc-args.txt')),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(lstat(bundlePath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        lstat(path.join(rootDir, 'external/bundle.d.ts')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(externalMarker, 'utf8')).resolves.toBe(
        'external marker bytes\n',
      );
    });
  });

  it('rejects an inherited outFile even when it is lexically inside outDir', async () => {
    await withCliBuildFixture(async ({ cliPath, rootDir }) => {
      await writeText(
        path.join(rootDir, 'packages/pkg/tsconfig.lib.json'),
        stringifyConfig({
          compilerOptions: {
            ...buildCompilerOptions,
            noEmit: true,
            outFile: path.join(rootDir, 'packages/pkg/dist/bundle.js'),
          },
          include: ['src/**/*.ts'],
          liminaOptions: {
            outputs: { outDir: './dist', rootDir: './src' },
          },
        }),
      );

      const output = await runCliExpectFailure({
        args: ['build', 'packages/pkg/tsconfig.lib.json'],
        cliPath,
        rootDir,
      });

      expect(output).toContain('outFile');
      await expect(
        readFile(path.join(rootDir, 'tsc-args.txt')),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  it.each(['nested-directory-link', 'final-file-link'])(
    'rejects an unsafe user outDir %s before public managed build spawn',
    async (unsafeKind) => {
      await withCliBuildFixture(async ({ cliPath, rootDir }) => {
        const outDir = path.join(rootDir, 'packages/pkg/dist');
        const externalDir = path.join(rootDir, 'external');
        const markerPath = path.join(externalDir, 'marker.txt');
        await writeText(markerPath, 'external marker bytes\n');
        await mkdir(outDir, { recursive: true });
        await symlink(
          unsafeKind === 'nested-directory-link' ? externalDir : markerPath,
          path.join(
            outDir,
            unsafeKind === 'nested-directory-link' ? 'sub' : 'index.d.ts',
          ),
        );
        await writeText(
          path.join(rootDir, 'packages/pkg/tsconfig.lib.json'),
          stringifyConfig({
            compilerOptions: {
              ...buildCompilerOptions,
              noEmit: true,
            },
            include: ['src/**/*.ts'],
            liminaOptions: {
              outputs: { outDir: './dist', rootDir: './src' },
            },
          }),
        );

        const output = await runCliExpectFailure({
          args: ['build', 'packages/pkg/tsconfig.lib.json'],
          cliPath,
          rootDir,
        });

        expect(output).toContain('symbolic link or junction');
        await expect(
          readFile(path.join(rootDir, 'tsc-args.txt')),
        ).rejects.toMatchObject({
          code: 'ENOENT',
        });
        await expect(readFile(markerPath, 'utf8')).resolves.toBe(
          'external marker bytes\n',
        );
      });
    },
  );

  it.each([
    ['build', ['build', 'packages/pkg/tsconfig.lib.json'], 'tsbuildinfo/build'],
    ['checker dts', ['checker', 'build'], 'dts/checkers'],
    ['checker tsbuildinfo', ['checker', 'build'], 'tsbuildinfo/checkers'],
  ])(
    'rejects an unsafe internal %s runtime directory before checker spawn',
    async (_label, args, runtimeDirectory) => {
      await withCliBuildFixture(async ({ cliPath, rootDir }) => {
        const externalDir = path.join(rootDir, 'external');
        const markerPath = path.join(externalDir, 'marker.txt');
        const internalPath = path.join(rootDir, '.limina', runtimeDirectory);
        await writeText(markerPath, 'external marker bytes\n');
        await mkdir(path.dirname(internalPath), { recursive: true });
        await symlink(externalDir, internalPath);

        const output = await runCliExpectFailure({ args, cliPath, rootDir });

        expect(output).toContain('symbolic link or junction');
        await expect(
          readFile(path.join(rootDir, 'tsc-args.txt')),
        ).rejects.toMatchObject({
          code: 'ENOENT',
        });
        await expect(readFile(markerPath, 'utf8')).resolves.toBe(
          'external marker bytes\n',
        );
        await expect(
          lstat(path.join(externalDir, 'lib.tsbuildinfo')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      });
    },
  );

  it('rejects a final output tsBuildInfoFile symlink before public managed build spawn', async () => {
    await withCliBuildFixture(async ({ cliPath, rootDir }) => {
      const markerPath = path.join(rootDir, 'external/marker.txt');
      const buildInfoPath = path.join(
        rootDir,
        '.limina/tsbuildinfo/build/packages/pkg/lib.tsbuildinfo',
      );
      await writeText(markerPath, 'external marker bytes\n');
      await mkdir(path.dirname(buildInfoPath), { recursive: true });
      await symlink(markerPath, buildInfoPath);

      const output = await runCliExpectFailure({
        args: ['build', 'packages/pkg/tsconfig.lib.json'],
        cliPath,
        rootDir,
      });

      expect(output).toContain('symbolic link or junction');
      await expect(
        readFile(path.join(rootDir, 'tsc-args.txt')),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readFile(markerPath, 'utf8')).resolves.toBe(
        'external marker bytes\n',
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

    for (const { args, option } of [
      {
        args: [
          'checker',
          'build',
          'packages/pkg/tsconfig.lib.json',
          '--checker',
          'vue-tsc',
        ],
        option: 'checker',
      },
      {
        args: [
          'checker',
          'typecheck',
          'packages/pkg/tsconfig.lib.json',
          '--checker',
          'vue-tsc',
        ],
        option: 'checker',
      },
      {
        args: [
          'build',
          'packages/pkg/tsconfig.lib.json',
          '--checker',
          'vue-tsc',
        ],
        option: 'checker',
      },
      {
        args: [
          'checker',
          'build',
          '--project',
          'packages/pkg/tsconfig.lib.json',
        ],
        option: 'project',
      },
      {
        args: [
          'checker',
          'typecheck',
          '--project',
          'packages/pkg/tsconfig.lib.json',
        ],
        option: 'project',
      },
    ]) {
      let failure:
        | {
            code?: number;
            stderr?: string;
            stdout?: string;
          }
        | undefined;

      try {
        await execFileAsync(process.execPath, [cliPath, ...args]);
      } catch (error) {
        failure = error as typeof failure;
      }

      expect(failure?.code).not.toBe(0);
      expect(failure?.stderr).toContain(`Unknown option: --${option}.`);
      expect(failure?.stderr).not.toContain('Use --preset instead.');
      expect(failure?.stderr).not.toContain(
        'Pass the config as a positional argument.',
      );
      expect(failure?.stdout ?? '').not.toContain('limina checker');
      expect(failure?.stdout ?? '').not.toContain('limina build');
    }

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
  }, 30_000);

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

  it('prints source and Proof issue filters from the last run', async () => {
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
      const normalizedCheckFailureStdout = checkFailurePlainStdout
        .replaceAll(/\s*│\s*/gu, ' ')
        .replaceAll(/\s+/gu, ' ');

      expect(checkFailurePlainStdout).toContain('Limina check summary');
      expect(checkFailurePlainStdout).not.toContain('Result: FAILED');
      expect(checkFailurePlainStdout).not.toContain('Blocked at: source:check');
      expect(checkFailurePlainStdout).toContain('Executed tasks: 5 / 5');
      expect(checkFailurePlainStdout).toContain('✕ source:check');
      expect(checkFailurePlainStdout).toContain('✕ knip source usage');
      expect(checkFailurePlainStdout).toContain('Next commands:');
      expect(normalizedCheckFailureStdout).toContain(
        'check --issues --verbose',
      );
      expect(checkFailureStdout).toContain(
        `${ANSI_ESCAPE}[34mExecuted tasks:${ANSI_ESCAPE}[0m 5 / 5`,
      );
      expect(checkFailurePlainStdout).not.toContain('Source check summary');

      for (const configSource of [
        'export default {\n',
        'export default { config: { checkers: 42 } };\n',
        'export default () => { throw new Error("config executed"); };\n',
      ]) {
        await writeText(path.join(rootDir, 'limina.config.mjs'), configSource);
        const explicitQuery = await execFileAsync(
          process.execPath,
          [
            cliPath,
            '--config',
            path.join(rootDir, 'limina.config.mjs'),
            '--config-loader',
            'unavailable',
            '--mode',
            'must-not-run',
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
        const defaultNestedQuery = await execFileAsync(
          process.execPath,
          [cliPath, 'check', '--issues', '--format', 'json'],
          {
            cwd: path.join(rootDir, 'app/src'),
            env: {
              ...process.env,
              CI: 'true',
            },
          },
        );

        expect(JSON.parse(explicitQuery.stdout)).toMatchObject({
          issueCount: 3,
        });
        expect(JSON.parse(defaultNestedQuery.stdout)).toMatchObject({
          issueCount: 3,
        });
      }

      const missingConfigQuery = await execFileAsync(
        process.execPath,
        [
          cliPath,
          '--config',
          path.join(rootDir, 'missing.config.mjs'),
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

      expect(JSON.parse(missingConfigQuery.stdout)).toMatchObject({
        issueCount: 3,
      });

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
      const plainResult = stripAnsi(result.stdout);

      expect(plainResult).toContain('Limina check issue summary');
      expect(plainResult).toContain('Matched: 3 / 3 issues');
      expect(plainResult).toContain('Command: limina check');
      expect(plainResult).toContain('Issue overview:');
      expect(plainResult).toContain('source:check (1)');
      expect(plainResult).toContain('checker:build (1)');
      expect(plainResult).toContain('proof:check (1)');
      expect(plainResult).toContain('Packages: @example/app (1)');
      expect(plainResult).toContain('1  LIMINA_SOURCE_UNUSED_MODULE');
      expect(plainResult).toContain('Next commands:');
      const normalizedResult = plainResult
        .replaceAll(/\s*│\s*/gu, ' ')
        .replaceAll(/\s+/gu, ' ');
      expect(normalizedResult).toContain(
        'check --issues --task proof:check --rule LIMINA_PROOF_DEFAULT_TSCONFIG_INVALID',
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
      const plainDetailsResult = stripAnsi(detailsResult.stdout);

      expect(plainDetailsResult).toContain('Showing 3 of 3 issues');
      expect(plainDetailsResult).toContain('Unused source module');
      expect(plainDetailsResult).toContain('fix steps:');

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
      expect(jsonPayload.topBlockers[0]).toMatchObject({
        code: 'LIMINA_PROOF_DEFAULT_TSCONFIG_INVALID',
        task: 'proof:check',
      });

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
      const plainRuleFilteredResult = stripAnsi(ruleFilteredResult.stdout);

      expect(plainRuleFilteredResult).toContain('Filters:');
      expect(plainRuleFilteredResult).toContain(
        'rule: LIMINA_SOURCE_UNUSED_MODULE',
      );
      expect(plainRuleFilteredResult).toContain('Matched: 1 / 3 issues');
      expect(plainRuleFilteredResult).toContain(
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
      const plainPackageFilteredResult = stripAnsi(
        packageFilteredResult.stdout,
      );

      expect(plainPackageFilteredResult).toContain('Filters:');
      expect(plainPackageFilteredResult).toContain('package: @example/app');
      expect(plainPackageFilteredResult).toContain('Matched: 2 / 3 issues');

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
      const plainUnmatchedRuleOutput = stripAnsi(unmatchedRuleResult.stdout);
      const normalizedUnmatchedRuleOutput = plainUnmatchedRuleOutput
        .replaceAll(/\s*│\s*/gu, ' ')
        .replaceAll(/\s+/gu, ' ');
      expect(plainUnmatchedRuleOutput).toContain('Matched: 0 / 3 issues');
      expect(plainUnmatchedRuleOutput).toContain(
        'rule: LIMINA_GRAPH_CHECK_FAILED',
      );
      expect(plainUnmatchedRuleOutput).toContain('Top rules:');
      expect(plainUnmatchedRuleOutput).toContain('(none)');
      expect(plainUnmatchedRuleOutput).toContain('Filter diagnostics:');
      expect(normalizedUnmatchedRuleOutput).toContain(
        'Supported rule "LIMINA_GRAPH_CHECK_FAILED"',
      );
      expect(normalizedUnmatchedRuleOutput).toContain(
        'absent from the last snapshot.',
      );
      expect(normalizedUnmatchedRuleOutput).toContain('--rule --help');
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  }, 40_000);

  it('supports bounded human issue views while keeping machine output complete', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-cli-issues-limit-')),
    );
    const cliPath = fileURLToPath(
      new URL('../../bin/limina.js', import.meta.url),
    );
    const environment = { ...process.env, CI: 'true' };

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages:\n  - packages/*\n',
      );
      await writeText(
        path.join(rootDir, 'package.json'),
        stringifyConfig({ name: 'root', private: true }),
      );
      await writeText(
        path.join(rootDir, '.limina/check/last-run.json'),
        stringifyConfig({
          command: 'limina check recorded-command-that-must-not-be-reused',
          createdAt: '2026-07-17T00:00:00.000Z',
          issues: Array.from({ length: 25 }, (_, index) => ({
            code: 'LIMINA_SOURCE_UNUSED_MODULE',
            detailLines: [`raw diagnostic ${index}`],
            filePath: `packages/app/src/file-${String(index).padStart(2, '0')}.ts`,
            packageName: '@example/app',
            reason: 'The module is unused.',
            summary: 'Unused source module.',
            task: 'source:check',
            title: 'Unused source module',
          })),
          status: 'completed',
          version: 7,
        }),
      );
      const invocationId = '00000000-0000-4000-8000-000000000000';
      await writeText(
        path.join(rootDir, '.limina/check/invocations', `${invocationId}.json`),
        stringifyConfig({
          command: 'recorded standalone command --not-a-query-template',
          completedAt: '2026-07-17T00:00:01.000Z',
          invocationId,
          issues: [
            {
              code: 'LIMINA_SOURCE_UNUSED_MODULE',
              filePath: 'packages/app/src/invocation.ts',
              reason: 'The invocation failed.',
              task: 'source:check',
              title: 'Invocation issue',
            },
          ],
          kind: 'standalone-invocation',
          result: 'failed',
          version: 1,
        }),
      );

      const runIssues = (args: readonly string[]) =>
        execFileAsync(
          process.execPath,
          [cliPath, 'check', '--issues', ...args],
          {
            cwd: rootDir,
            env: environment,
          },
        );
      const summary = await runIssues([]);
      const compact = await runIssues(['--limit', '5']);
      const allCompact = await runIssues(['--limit', 'all']);
      const detailed = await runIssues(['--verbose']);
      const allDetailed = await runIssues(['--verbose', '--limit', 'all']);
      const json = await runIssues(['--format', 'json']);
      const verboseJson = await runIssues(['--verbose', '--format', 'json']);
      const ndjson = await runIssues(['--format', 'ndjson']);
      const verboseNdjson = await runIssues([
        '--verbose',
        '--format',
        'ndjson',
      ]);
      const invocation = await runIssues(['--invocation', invocationId]);
      const normalizedInvocation = stripAnsi(invocation.stdout)
        .replaceAll(/\s*│\s*/gu, ' ')
        .replaceAll(/\s+/gu, ' ');

      expect(summary.stdout).not.toContain('Showing');
      expect(summary.stdout).toContain('Show issues:');
      expect(summary.stdout).toContain('--limit 20');
      expect(compact.stdout).toContain('Showing 5 of 25 issues');
      expect(compact.stdout).not.toContain('raw diagnostic');
      expect(allCompact.stdout).toContain('Showing 25 of 25 issues');
      expect(allCompact.stdout).not.toContain('raw diagnostic');
      expect(detailed.stdout).toContain('Showing 20 of 25 issues');
      expect(detailed.stdout).toContain('raw diagnostic 0');
      expect(detailed.stdout).not.toContain('raw diagnostic 24');
      expect(allDetailed.stdout).toContain('Showing 25 of 25 issues');
      expect(allDetailed.stdout).toContain('raw diagnostic 24');
      expect(verboseJson.stdout).toBe(json.stdout);
      expect(verboseNdjson.stdout).toBe(ndjson.stdout);
      expect(JSON.parse(json.stdout)).toMatchObject({ issueCount: 25 });
      expect(ndjson.stdout.trim().split('\n')).toHaveLength(25);
      expect(invocation.stdout).toContain(`Invocation: ${invocationId}`);
      expect(invocation.stdout).toContain('Kind: standalone-invocation');
      expect(invocation.stdout).toContain('Result: failed');
      expect(invocation.stdout).toContain('Showing 1 of 1 issues');
      expect(normalizedInvocation).toContain(
        `limina check --issues --invocation ${invocationId}`,
      );
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  }, 40_000);

  it('validates issue limits before reading a workspace or snapshot', async () => {
    const rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-cli-limit-invalid-')),
    );
    const cliPath = fileURLToPath(
      new URL('../../bin/limina.js', import.meta.url),
    );
    const environment = { ...process.env, CI: 'true' };
    const run = (args: readonly string[]) =>
      execFileAsync(process.execPath, [cliPath, 'check', ...args], {
        cwd: rootDir,
        env: environment,
      });

    try {
      for (const value of [
        '0',
        '-1',
        '1.5',
        '1e2',
        'invalid',
        '9007199254740992',
      ]) {
        await expect(run(['--issues', '--limit', value])).rejects.toMatchObject(
          {
            stderr: expect.stringContaining(
              `Invalid check --issues --limit "${value}"`,
            ),
          },
        );
      }

      for (const format of ['json', 'ndjson']) {
        await expect(
          run(['--issues', '--limit', '20', '--format', format]),
        ).rejects.toMatchObject({
          stderr: expect.stringContaining(
            '`limina check --issues --limit` is only available with --format human.',
          ),
        });
      }

      await expect(run(['--limit', '20'])).rejects.toMatchObject({
        stderr: expect.stringContaining(
          '`--invocation`, and `--limit` require --issues.',
        ),
      });
    } finally {
      await rm(rootDir, { force: true, recursive: true });
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
        'export default {\n',
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
      const missingTaskHelpResult = await execFileAsync(
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
          env: { ...process.env, CI: 'true' },
        },
      );
      const missingTaskHelpPlainStdout = stripAnsi(
        missingTaskHelpResult.stdout,
      );
      for (const task of PUBLIC_CHECK_ISSUE_TASKS) {
        expect(missingTaskHelpPlainStdout).toContain(`- ${task}  0 issues`);
      }

      await expect(
        execFileAsync(
          process.execPath,
          [cliPath, 'check', '--issues', '--invocation', 'not-a-uuid'],
          {
            cwd: rootDir,
            env: { ...process.env, CI: 'true' },
          },
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          'Invalid standalone issue invocation ID: not-a-uuid.',
        ),
      });
      const missingInvocationId = '00000000-0000-4000-8000-000000000000';
      await expect(
        execFileAsync(
          process.execPath,
          [cliPath, 'check', '--issues', '--invocation', missingInvocationId],
          {
            cwd: rootDir,
            env: { ...process.env, CI: 'true' },
          },
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          `No standalone issue invocation found for ${missingInvocationId}.`,
        ),
      });

      await writeText(
        path.join(rootDir, '.limina/check/last-run.json'),
        stringifyConfig({
          command: 'limina check',
          createdAt: '2026-06-21T00:00:00.000Z',
          issues: [],
          run: {
            command: 'limina check',
            completedAt: '2026-06-21T00:00:00.000Z',
            createdAt: '2026-06-21T00:00:00.000Z',
            durationMs: 0,
            pipeline: 'default',
            result: 'passed',
            startedAt: '2026-06-21T00:00:00.000Z',
            tasks: [
              {
                completedAt: '2026-06-21T00:00:00.000Z',
                durationMs: 0,
                generation: 0,
                id: 'task:source-check',
                issueTask: 'source:check',
                kind: 'task',
                label: 'source:check',
                startedAt: '2026-06-21T00:00:00.000Z',
                state: 'passed',
              },
            ],
          },
          status: 'completed',
          version: 7,
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
      for (const task of PUBLIC_CHECK_ISSUE_TASKS) {
        expect(emptyTaskHelpPlainStdout).toContain(`- ${task}  0 issues`);
      }
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
        'No package filters are available',
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
      expect(emptyCheckerHelpPlainStdout).toContain(
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
          version: 7,
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
      expect(taskHelpPlainStdout).toContain('- command  0 issues');
      expect(taskHelpPlainStdout).toContain('- package:check  0 issues');
      expect(taskHelpPlainStdout).toContain('- release:check  0 issues');

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
          '`limina check --task`, `--checker`, `--format`, `--invocation`, and `--limit` require --issues.',
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

  it('does not import config while reading checker filter help', async () => {
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
        'throw new Error("config must not execute");\n',
      );
      await writeText(
        path.join(rootDir, 'app/src/index.ts'),
        'export const value = 1;\n',
      );
      await writeText(
        path.join(rootDir, 'app/package.json'),
        stringifyConfig({
          name: 'app',
          private: true,
        }),
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
      expect(plainStdout).toContain('No check issue snapshot found.');
      expect(plainStdout).not.toContain('config must not execute');
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
        await readFile(path.join(rootDir, 'limina.config.mts'), 'utf8'),
      ).toContain("mode: 'auto'");
      expect(
        await readFile(path.join(rootDir, 'limina.config.mts'), 'utf8'),
      ).toContain('exclude: []');
      expect(
        await readFile(path.join(rootDir, 'limina.config.mts'), 'utf8'),
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
