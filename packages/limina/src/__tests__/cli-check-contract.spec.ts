import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
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
import { promisify, stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createFixturePathResolver, toPortablePath } from './helpers/path';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../../bin/limina.js', import.meta.url));

async function createFixture() {
  const temporaryPath = await mkdtemp(
    path.join(tmpdir(), 'limina check contract '),
  );
  const rootDirectory = await realpath(temporaryPath);
  const fixturePath = createFixturePathResolver(rootDirectory);
  await writeFile(
    fixturePath('package.json'),
    '{"name":"contract-fixture","private":true,"type":"module"}\n',
  );
  await writeFile(fixturePath('pnpm-workspace.yaml'), 'packages: []\n');
  await mkdir(fixturePath('configured cwd'));
  const capture =
    `require('node:fs').appendFileSync(${JSON.stringify(fixturePath('command.jsonl'))}, ` +
    `JSON.stringify({args: process.argv.slice(1), cwd: process.cwd(), env: process.env.PIPELINE_INPUT}) + '\\n')`;
  const command = {
    args: ['-e', capture, 'configured argument'],
    command: process.execPath,
    cwd: 'configured cwd',
    env: { PIPELINE_INPUT: 'configured environment' },
    type: 'command',
  };
  await writeFile(
    fixturePath('limina.config.mjs'),
    `import { writeFileSync } from 'node:fs';\n` +
      `writeFileSync(${JSON.stringify(fixturePath('evaluated.txt'))}, 'loaded');\n` +
      `export default ({mode}) => ({ pipelines: mode === 'missing' ? {} : ${JSON.stringify(
        {
          graph: [command],
          'graph:check': [command],
          lint: [command],
          format: [command],
          commit: [command],
          multi: [
            command,
            { ...command, args: ['-e', capture, 'second argument'] },
          ],
        },
      )} });\n`,
  );
  return {
    path: fixturePath,
    rootDir: rootDirectory,
    run: (arguments_: string[]) =>
      execFileAsync(process.execPath, [cliPath, ...arguments_], {
        cwd: rootDirectory,
        env: { ...process.env, CI: 'true' },
        timeout: 20_000,
      }),
  };
}

describe('check CLI workflow contract', () => {
  it.each([
    ['lint', ['--fix']],
    ['commit', ['message.txt']],
    ['format', ['--', '--write']],
    ['format', ['--']],
    ['lint', ['-x']],
    ['lint', ['--fix', '--help']],
    ['lint', ['--verbose.extra']],
    ['lint', ['--package.entry', 'cli-only']],
    ['lint', ['--issues', '--task', '--help', '--', '--verbose']],
    ['lint', ['--', '--issues', '--limit', '0']],
  ] as const)(
    'rejects runtime arguments for %s before configuration evaluation: %j',
    async (pipeline, arguments_) => {
      const fixture = await createFixture();
      const snapshot = fixture.path('.limina/check/last-run.json');
      const previousSnapshot = '{"sentinel":"unchanged"}\n';
      try {
        await mkdir(fixture.path('.limina/check'), { recursive: true });
        await writeFile(snapshot, previousSnapshot);
        let failure: { code?: number; stderr?: string } | undefined;
        try {
          await fixture.run(['check', pipeline, ...arguments_]);
        } catch (error) {
          failure = error as typeof failure;
        }
        expect(failure).toMatchObject({
          code: 1,
        });
        expect(stripVTControlCharacters(failure?.stderr ?? '')).toContain(
          `\`limina check ${pipeline}\` does not accept runtime arguments.\nConfigure the pipeline in the Limina config under \`pipelines.${pipeline}\`.`,
        );
        expect(existsSync(fixture.path('evaluated.txt'))).toBe(false);
        expect(existsSync(fixture.path('command.jsonl'))).toBe(false);
        expect(await readFile(snapshot, 'utf8')).toBe(previousSnapshot);
      } finally {
        await rm(fixture.rootDir, { recursive: true, force: true });
      }
    },
  );

  it('selects named workflows independently of builtin commands', async () => {
    const fixture = await createFixture();
    try {
      for (const selector of ['graph', 'graph:check']) {
        await fixture.run(['check', selector]);
        expect(existsSync(fixture.path('command.jsonl'))).toBe(true);
        await rm(fixture.path('command.jsonl'));
      }
      await fixture.run(['graph', 'check']);
      expect(existsSync(fixture.path('command.jsonl'))).toBe(false);
      for (const selector of ['graph', 'graph:check']) {
        await expect(
          fixture.run(['--mode', 'missing', 'check', selector]),
        ).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining(
            `Pipeline instruction "${selector}" was not found.`,
          ),
        });
      }
    } finally {
      await rm(fixture.rootDir, { recursive: true, force: true });
    }
  });

  it('keeps CLI options out of every external command in an ordered workflow', async () => {
    const fixture = await createFixture();
    try {
      await fixture.run([
        'check',
        'multi',
        '--package',
        'cli-only',
        '--verbose',
      ]);
      const records = (await readFile(fixture.path('command.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as { args: string[]; cwd: string; env: string },
        );
      expect(records.map((record) => record.args)).toEqual([
        ['configured argument'],
        ['second argument'],
      ]);
      for (const record of records) {
        expect(toPortablePath(record.cwd)).toBe(fixture.path('configured cwd'));
        expect(record.env).toBe('configured environment');
      }
    } finally {
      await rm(fixture.rootDir, { recursive: true, force: true });
    }
  });
});
