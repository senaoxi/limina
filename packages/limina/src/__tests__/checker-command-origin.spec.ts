import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createTscCommandTarget } from '../checker/command-targets';
import { collectCheckerPeerDependencyDetails } from '../typecheck/targets';
import { createFixturePathResolver } from './helpers/path';

const requireFromTest = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const fixturePath = createFixturePathResolver(process.cwd());
const checker = {
  name: 'tsc' as const,
  include: ['tsconfig.json'],
  exclude: [],
  extensions: [],
};
const options = {
  checker,
  configPath: fixturePath('tsconfig.json'),
  executionKind: 'build' as const,
  projectRootDir: fixturePath(),
};

describe('TypeScript command installation origin', () => {
  it('runs the same actual compiler version accepted by runtime preflight', async () => {
    expect(
      collectCheckerPeerDependencyDetails({
        checkers: [checker],
        projectRootDir: options.projectRootDir,
      }),
    ).toEqual([]);
    const target = createTscCommandTarget(options);
    expect(target.command).toBe(process.execPath);
    expect(target.args[0]).toBe(requireFromTest.resolve('typescript/bin/tsc'));
    const result = await execFileAsync(
      target.command,
      [target.args[0]!, '--version'],
      {
        env: { ...process.env, PATH: '' },
      },
    );
    expect(result.stdout.trim()).toBe(`Version ${ts.version}`);
  });

  it('keeps build/watch arguments after the resolved compiler entry', () => {
    const target = createTscCommandTarget({ ...options, watch: true });
    expect(target.args.slice(1)).toEqual([
      '-b',
      'tsconfig.json',
      '--pretty',
      'false',
      '--watch',
      '--preserveWatchOutput',
    ]);
    expect(target.label).toBe('tsc -b tsconfig.json --watch');
  });

  it('preserves explicit runner command overrides', () => {
    const target = createTscCommandTarget({
      ...options,
      commandOverride: 'custom-tsc',
    });
    expect(target.command).toBe('custom-tsc');
    expect(target.args).toEqual(['-b', 'tsconfig.json', '--pretty', 'false']);
  });
});
