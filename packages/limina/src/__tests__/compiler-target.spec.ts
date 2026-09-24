import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { readExplicitSourceCompilerTarget } from '../core/build-graph/generated/compiler-target';
import { resolveFixtureGovernanceRoot } from './helpers/governance-root';
import { createFixturePathResolver } from './helpers/path';

describe('effective output compiler target', () => {
  it.each([
    {
      name: 'independent branches',
      right: { compilerOptions: { target: 'ES2019' } },
      bases: ['./a.json', './b.json'],
      expected: 'ES2019',
    },
    {
      name: 'diamond inheritance',
      right: { extends: './base.json' },
      bases: ['./a.json', './b.json'],
      expected: 'ES2020',
    },
    {
      name: 'deep shared ancestor',
      right: { extends: './bridge.json' },
      bases: ['./a.json', './b.json'],
      expected: 'ES2020',
    },
    {
      name: 'direct and indirect reuse',
      right: {},
      bases: ['./a.json', './base.json'],
      expected: 'ES2020',
    },
    {
      name: 'reversed precedence',
      right: { extends: './base.json' },
      bases: ['./b.json', './a.json'],
      expected: 'ES2022',
    },
    {
      name: 'own override',
      right: { extends: './base.json' },
      bases: ['./a.json', './b.json'],
      own: 'ES2021',
      expected: 'ES2021',
    },
  ])(
    'agrees with TypeScript for $name',
    async ({ right, bases, own, expected }) => {
      const rootDir = await realpath(
        await mkdtemp(path.join(tmpdir(), 'limina-target-')),
      );
      const fixturePath = createFixturePathResolver(rootDir);
      const configs = {
        'base.json': { compilerOptions: { target: 'ES2020' } },
        'bridge.json': { extends: './base.json' },
        'a.json': {
          extends: './base.json',
          compilerOptions: { target: 'ES2022' },
        },
        'b.json': right,
        'tsconfig.json': {
          extends: bases,
          compilerOptions: { types: [], ...(own ? { target: own } : {}) },
          files: ['index.ts'],
        },
      };
      try {
        await mkdir(rootDir, { recursive: true });
        for (const [file, value] of Object.entries(configs)) {
          await writeFile(fixturePath(file), JSON.stringify(value));
        }
        await writeFile(fixturePath('index.ts'), 'export const value = 1;');
        const configPath = fixturePath('tsconfig.json');
        const diagnostics: ts.Diagnostic[] = [];
        const parsed = ts.getParsedCommandLineOfConfigFile(
          configPath,
          {},
          {
            ...ts.sys,
            onUnRecoverableConfigFileDiagnostic: (diagnostic) =>
              diagnostics.push(diagnostic),
          },
        );
        expect(diagnostics).toEqual([]);
        expect(parsed?.errors).toEqual([]);
        expect(ts.ScriptTarget[parsed!.options.target!]).toBe(expected);
        expect(
          readExplicitSourceCompilerTarget({
            config: {
              get governanceRoot() {
                return resolveFixtureGovernanceRoot(this);
              },
              rootDir,
              configPath: fixturePath('limina.config.mts'),
              config: {},
            },
            configPath,
          }),
        ).toBe(expected);
      } finally {
        await rm(rootDir, { recursive: true, force: true });
      }
    },
  );
});
