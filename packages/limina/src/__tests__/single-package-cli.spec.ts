import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { readdir, readFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify, stripVTControlCharacters } from 'node:util';
import { expect, it } from 'vitest';
import { readSourceIssueSnapshot } from '../check-reporting/snapshot';
import { createSinglePackageFixture } from './helpers/single-package';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../../bin/limina.js', import.meta.url));

async function runCli(cwd: string, args: string[]) {
  try {
    return {
      status: 0,
      ...(await execFileAsync(process.execPath, [cliPath, ...args], {
        cwd,
        env: { ...process.env, CI: 'true' },
      })),
    };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    return {
      status: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
}

async function readState(directory: string) {
  const paths = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return Promise.all(
    paths
      .filter((entry) => entry.isFile())
      .map(async (entry) => [
        `${entry.parentPath}/${entry.name}`,
        await readFile(`${entry.parentPath}/${entry.name}`, 'utf8'),
      ]),
  );
}

it('replays the emitted invocation query after config removal without loading config or running governance', async () => {
  const f = await createSinglePackageFixture({
    'pnpm-workspace.yaml': 'packages: [local]',
    'local/package.json': JSON.stringify({
      exports: { '.': './src/index.ts' },
    }),
    'local/limina.config.mjs': [
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(new URL('./config-imports.txt', import.meta.url), 'import\\n');",
      'export default { source: { knip: { root: {} } } };',
    ].join('\n'),
    'local/src/index.ts': 'export const value = 1;',
    'local/src/dead.ts': 'export const dead = 1;',
    'local/tsconfig.json': JSON.stringify({
      compilerOptions: {
        noEmit: true,
        module: 'ESNext',
        moduleResolution: 'Bundler',
      },
      include: ['src/**/*.ts'],
    }),
  });
  try {
    const configPath = f.path('local/limina.config.mjs');
    const check = await runCli(f.path(), ['--config', configPath, 'check']);
    expect(check.status).toBe(1);
    const lastRun = await readFile(
      f.path('local/.limina/check/last-run.json'),
      'utf8',
    );
    expect(lastRun).toContain('LIMINA_SOURCE_UNUSED_MODULE');
    const standalone = await runCli(f.path(), [
      '--config',
      configPath,
      'source',
      'check',
    ]);
    expect(standalone.status).toBe(1);
    expect((await readSourceIssueSnapshot(f.path('local')))?.issues).toEqual([
      { code: 'LIMINA_SOURCE_UNUSED_MODULE', filePath: 'src/dead.ts' },
    ]);
    const output = stripVTControlCharacters(
      standalone.stdout + standalone.stderr,
    );
    const label = process.platform === 'win32' ? 'PowerShell: ' : 'Query: ';
    const query = output
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith(label))
      ?.slice(label.length);
    expect(query).toBeDefined();
    const encodedArgs = /'([A-Za-z0-9+/=]+)'$/u.exec(query!)?.[1];
    const queryText =
      process.platform === 'win32'
        ? (
            JSON.parse(
              Buffer.from(encodedArgs!, 'base64').toString('utf8'),
            ) as string[]
          ).join(' ')
        : query!;
    expect(queryText).toContain('bin/limina.js');
    expect(queryText).toContain(configPath);
    const invocationId = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/u.exec(
      queryText,
    )?.[0];
    expect(invocationId).toBeDefined();
    const imports = await readFile(f.path('local/config-imports.txt'), 'utf8');
    const state = await readState(f.path('local/.limina'));
    await rename(configPath, f.path('local/removed-config.mjs'));
    // Neither ancestor workspace validity nor the execution-only manager metadata can redirect a query.
    await f.write('pnpm-workspace.yaml', 'packages: [');
    await f.write(
      'local/package.json',
      JSON.stringify({ workspaces: [], packageManager: 'invalid' }),
    );
    const replay = await execFileAsync(
      process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
      process.platform === 'win32'
        ? [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `${query} --format json`,
          ]
        : ['-c', `${query} --format json`],
      {
        cwd: f.path(),
        env: { ...process.env, CI: 'true' },
      },
    );
    const payload = JSON.parse(replay.stdout);
    expect(payload).toMatchObject({
      invocationId,
      kind: 'standalone-invocation',
      result: 'failed',
    });
    expect(payload.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'LIMINA_SOURCE_UNUSED_MODULE' }),
      ]),
    );
    expect(await readState(f.path('local/.limina'))).toEqual(state);
    expect(await readFile(f.path('local/config-imports.txt'), 'utf8')).toBe(
      imports,
    );
    expect(
      await readFile(f.path('local/.limina/check/last-run.json'), 'utf8'),
    ).toBe(lastRun);
    expect(
      (await runCli(f.path(), ['--config', configPath, 'source', 'check']))
        .status,
    ).toBe(1);
  } finally {
    await f.cleanup();
  }
}, 60_000);
