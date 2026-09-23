import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { inspectFrameworkIntent } from '../core/build-graph/framework-intent';
import { readExplicitSourceCompilerTarget } from '../core/build-graph/generated/compiler-target';
import { createFixturePathResolver } from './helpers/path';

async function createFixture(files: Record<string, unknown>) {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-inherits-')),
  );
  const fixturePath = createFixturePathResolver(rootDir);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(fixturePath(file)), { recursive: true });
    await writeFile(fixturePath(file), JSON.stringify(content));
  }
  await writeFile(fixturePath('index.ts'), 'export const value = 1;');
  return {
    rootDir,
    path: fixturePath,
    cleanup: () => rm(rootDir, { recursive: true, force: true }),
  };
}

const inherited = {
  compilerOptions: { target: 'ES2020', types: [] },
  vueCompilerOptions: { strictTemplates: true },
};
const packageRoot = 'node_modules/@fixture/config';

describe('TypeScript inherited config identity', () => {
  it.each([
    {
      name: 'explicit JSON',
      request: './base.json',
      source: 'base.json',
      files: { 'base.json': inherited },
    },
    {
      name: 'dotted file',
      request: './base.config',
      source: 'base.config.json',
      files: { 'base.config.json': inherited },
    },
    {
      name: 'exact extensionless file',
      request: './base',
      source: 'base',
      files: { base: inherited },
    },
    {
      name: 'package default',
      request: '@fixture/config',
      source: `${packageRoot}/tsconfig.json`,
      files: {
        [`${packageRoot}/package.json`]: { name: '@fixture/config' },
        [`${packageRoot}/tsconfig.json`]: inherited,
      },
    },
    {
      name: 'package tsconfig field',
      request: '@fixture/config',
      source: `${packageRoot}/custom.json`,
      files: {
        [`${packageRoot}/package.json`]: {
          name: '@fixture/config',
          tsconfig: './custom.json',
        },
        [`${packageRoot}/custom.json`]: inherited,
      },
    },
    {
      name: 'package subpath',
      request: '@fixture/config/base.config',
      source: `${packageRoot}/base.config.json`,
      files: {
        [`${packageRoot}/package.json`]: { name: '@fixture/config' },
        [`${packageRoot}/base.config.json`]: inherited,
      },
    },
  ])(
    'uses the same target and framework ancestor for $name',
    async ({ request, source, files }) => {
      const raw = { extends: request, files: ['index.ts'] };
      const fixture = await createFixture({ ...files, 'tsconfig.json': raw });
      try {
        const configPath = fixture.path('tsconfig.json');
        const options = {
          configPath,
          config: {
            rootDir: fixture.rootDir,
            configPath: fixture.path('limina.config.mts'),
            config: {},
          },
        };
        const parsed = ts.getParsedCommandLineOfConfigFile(
          configPath,
          {},
          {
            ...ts.sys,
            onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
              throw new Error(
                ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
              );
            },
          },
        );
        expect(parsed?.errors).toEqual([]);
        expect(readExplicitSourceCompilerTarget(options)).toBe(
          ts.ScriptTarget[parsed!.options.target!],
        );
        expect(
          inspectFrameworkIntent({ ...options, configObject: raw }),
        ).toEqual({
          intentHints: [
            {
              configPath: fixture.path(source),
              family: 'vue',
              kind: 'vue-compiler-options',
              value: 'vueCompilerOptions',
            },
          ],
          problems: [],
        });
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each([
    { name: 'missing extends', files: {}, raw: { extends: './missing.json' } },
    {
      name: 'inheritance cycle',
      files: { 'base.json': { extends: './tsconfig.json' } },
      raw: { extends: './base.json' },
    },
    {
      name: 'invalid target',
      files: { 'base.json': { compilerOptions: { target: 'not-a-target' } } },
      raw: { extends: './base.json' },
    },
  ])('retains parser failure for $name', async ({ files, raw }) => {
    const fixture = await createFixture({
      ...files,
      'tsconfig.json': { ...raw, files: ['index.ts'] },
    });
    try {
      const options = {
        configPath: fixture.path('tsconfig.json'),
        config: {
          rootDir: fixture.rootDir,
          configPath: fixture.path('limina.config.mts'),
          config: {},
        },
      };
      expect(() => readExplicitSourceCompilerTarget(options)).toThrow();
      const inspection = inspectFrameworkIntent({
        ...options,
        configObject: raw,
      });
      expect(inspection.intentHints).toEqual([]);
      expect(inspection.problems).toHaveLength(1);
      expect(inspection.problems[0]).toContain(
        'Unavailable auto checker extends config',
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
