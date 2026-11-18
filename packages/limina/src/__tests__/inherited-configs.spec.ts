import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { parseTypeScriptCommandLine } from '../checker/project-base';
import { emptyMetrics } from '../core/analysis-cache/cache-metrics';
import { ResolvedConfigRecords } from '../core/analysis-cache/resolved-config-records';
import { inspectFrameworkIntent } from '../core/build-graph/framework-intent';
import { readExplicitSourceCompilerTarget } from '../core/build-graph/generated/compiler-target';
import { withFixtureGovernanceRoot } from './helpers/governance-root';
import { createFixturePathResolver } from './helpers/path';

async function createFixture(files: Record<string, unknown>) {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), 'limina-inherits-'),
  );
  const rootDirectory = await realpath(temporaryDirectory);
  const fixturePath = createFixturePathResolver(rootDirectory);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(fixturePath(file)), { recursive: true });
    await writeFile(fixturePath(file), JSON.stringify(content));
  }
  await writeFile(fixturePath('index.ts'), 'export const value = 1;');
  return {
    rootDir: rootDirectory,
    path: fixturePath,
    cleanup: () => rm(rootDirectory, { recursive: true, force: true }),
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
          config: withFixtureGovernanceRoot({
            rootDir: fixture.rootDir,
            configPath: fixture.path('limina.config.mts'),
            scope: {},
          }),
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
        config: withFixtureGovernanceRoot({
          rootDir: fixture.rootDir,
          configPath: fixture.path('limina.config.mts'),
          scope: {},
        }),
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
  it('uses the contribution of a package-exported preset at its resolved filename', async () => {
    const fixture = await createFixture({
      'node_modules/astro/package.json': {
        name: 'astro',
        exports: { './tsconfigs/strict': './renamed.json' },
      },
      'node_modules/astro/renamed.json': { compilerOptions: { strict: true } },
      'base.json': { extends: 'astro/tsconfigs/strict' },
      'tsconfig.json': { extends: ['./base.json'], files: ['index.ts'] },
    });
    try {
      const config = withFixtureGovernanceRoot({
        rootDir: fixture.rootDir,
        configPath: fixture.path('limina.config.mts'),
        scope: {},
      });
      const configPath = fixture.path('tsconfig.json');
      const inspect = () =>
        inspectFrameworkIntent({ config, configObject: {}, configPath });
      const receipts = new ResolvedConfigRecords({}, emptyMetrics());
      const initial = receipts.run(inspect);
      expect(initial).toEqual({
        intentHints: [
          {
            configPath: fixture.path('base.json'),
            family: 'astro',
            kind: 'astro-preset',
            value: 'astro/tsconfigs/strict',
          },
        ],
        problems: [],
      });
      const metrics = emptyMetrics();
      const restored = new ResolvedConfigRecords(
        structuredClone(receipts.records),
        metrics,
      );
      expect(restored.run(inspect)).toEqual(initial);
      expect(metrics).toMatchObject({
        resolvedConfigHits: 1,
        resolvedConfigParses: 0,
      });
      await writeFile(
        configPath,
        JSON.stringify({
          extends: ['./base.json'],
          compilerOptions: { strict: false },
          files: ['index.ts'],
        }),
      );
      expect(restored.run(inspect)).toEqual({ intentHints: [], problems: [] });
      expect(inspect()).toEqual({ intentHints: [], problems: [] });
    } finally {
      await fixture.cleanup();
    }
  });

  it('preserves compiler paths and package-scope output remapping on restoration', async () => {
    const fixture = await createFixture({
      'config/base.json': {
        compilerOptions: {
          rootDir: '../pkg/src',
          outDir: '../pkg/dist',
          module: 'NodeNext',
          paths: { alias: ['./alias.ts'] },
        },
      },
      'config/alias.ts': {},
      'pkg/package.json': {
        name: 'receiver',
        type: 'module',
        imports: { '#self': './dist/inner.js' },
      },
      'pkg/src/inner.ts': {},
      'tsconfig.json': {
        extends: './config/base.json',
        files: ['pkg/src/inner.ts'],
      },
    });
    try {
      const configPath = fixture.path('tsconfig.json');
      const containing = fixture.path('pkg/src/inner.ts');
      const scope = (options: ts.CompilerOptions) =>
        ['#self', 'alias'].map(
          (name) =>
            ts.resolveModuleName(name, containing, options, ts.sys)
              .resolvedModule?.resolvedFileName,
        );
      const reference = ts.getParsedCommandLineOfConfigFile(
        configPath,
        {},
        {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
            throw new Error(String(diagnostic.code));
          },
        },
      )!;
      const expected = [undefined, fixture.path('config/alias.ts')];
      expect(scope(reference.options)).toEqual(expected);
      // A plain options object wrongly rebinds #self to the nested package's own source.
      expect(scope({ ...reference.options })[0]).toBe(containing);
      const parse = () =>
        parseTypeScriptCommandLine({
          parseOptions: { configPath, projectRootDir: fixture.rootDir },
        });
      const receipts = new ResolvedConfigRecords({}, emptyMetrics());
      expect(scope(receipts.run(parse).parsed.options)).toEqual(expected);
      const metrics = emptyMetrics();
      const restored = new ResolvedConfigRecords(
        structuredClone(receipts.records),
        metrics,
      );
      expect(scope(restored.run(parse).parsed.options)).toEqual(expected);
      expect(metrics).toMatchObject({
        resolvedConfigHits: 1,
        resolvedConfigParses: 0,
      });
    } finally {
      await fixture.cleanup();
    }
  });
});
