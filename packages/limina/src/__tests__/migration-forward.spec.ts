import { describe, expect, it } from 'vitest';
import { migrationArguments } from '../cli/migration-forward';

describe('legacy migration argument forwarding', () => {
  it.each([
    {
      args: ['migration', '--mode', 'value with ! & quotes'],
      expected: ['--mode', 'value with ! & quotes'],
    },
    {
      args: [
        '--config',
        'a path/config.mts',
        '--mode',
        'migration',
        'migration',
        '--config-loader=tsx',
      ],
      expected: [
        '--config',
        'a path/config.mts',
        '--mode',
        'migration',
        '--config-loader=tsx',
      ],
    },
    {
      args: ['--mode=migration', 'migration', '--', 'literal'],
      expected: ['--mode=migration', '--', 'literal'],
    },
    { args: ['--mode', 'migration', 'check'], expected: undefined },
    { args: ['--', 'migration'], expected: undefined },
  ])(
    'forwards only the actual migration subcommand: $args',
    ({ args, expected }) => {
      expect(migrationArguments(['node', 'limina', ...args])).toEqual(expected);
    },
  );
});
