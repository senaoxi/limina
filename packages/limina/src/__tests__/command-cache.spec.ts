import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectVueTsgoCommandConfigPaths,
  type CommandPipelineStep,
  createCommandCacheTargets,
} from '../pipeline/command-cache';
import { toPortablePaths } from './helpers/path';

function vueTsgoStep(args: string[]): CommandPipelineStep {
  return {
    args,
    command: 'vue-tsgo',
    type: 'command',
  };
}

describe('vue-tsgo command cache config arguments', () => {
  const cwd = path.resolve('/virtual/workspace');

  it.each([
    ['separated', ['--project', 'configs/alt.json']],
    ['equals', ['--project=configs/alt.json']],
  ])('normalizes the %s project form to the same absolute path', (_, args) => {
    expect(
      toPortablePaths(collectVueTsgoCommandConfigPaths(vueTsgoStep(args), cwd)),
    ).toEqual(toPortablePaths([path.resolve(cwd, 'configs/alt.json')]));
  });

  it('preserves absolute paths and the existing multiple-config strategy', () => {
    const absolute = path.resolve('/virtual/configs/absolute.json');

    expect(
      toPortablePaths(
        collectVueTsgoCommandConfigPaths(
          vueTsgoStep([
            '--project',
            absolute,
            '--project=relative.json',
            '-p',
            'short.json',
          ]),
          cwd,
        ),
      ),
    ).toEqual(
      toPortablePaths([
        absolute,
        path.resolve(cwd, 'relative.json'),
        path.resolve(cwd, 'short.json'),
      ]),
    );
  });

  it.each([
    ['missing separated value', ['--project']],
    ['next token is another flag', ['--project', '--pretty']],
    ['empty equals value', ['--project=']],
    ['unsupported short equals form', ['-p=alt.json']],
  ])('falls back to the default config for %s', (_, args) => {
    expect(
      toPortablePaths(collectVueTsgoCommandConfigPaths(vueTsgoStep(args), cwd)),
    ).toEqual(toPortablePaths([path.resolve(cwd, 'tsconfig.json')]));
  });

  it('uses one target identity for separated and equals spellings', () => {
    const separated = createCommandCacheTargets(
      vueTsgoStep(['--project', 'configs/alt.json']),
      cwd,
    );
    const equals = createCommandCacheTargets(
      vueTsgoStep(['--project=configs/alt.json']),
      cwd,
    );

    expect(separated.map(({ configPath, id }) => ({ configPath, id }))).toEqual(
      equals.map(({ configPath, id }) => ({ configPath, id })),
    );
  });
});
