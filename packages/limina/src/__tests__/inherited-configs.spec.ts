import { compareCodeUnits } from '#utils/collections';
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  CheckerProjectConfigCache,
  parseCheckerProjectConfigForContext,
} from '../checker/context';
import { parseTypeScriptCommandLine } from '../checker/project-base';
import { emptyMetrics } from '../core/analysis-cache/cache-metrics';
import { InvocationConfigReads } from '../core/analysis-cache/invocation-config-reads';
import { inspectFrameworkIntent } from '../core/build-graph/framework-intent';
import { readExplicitSourceCompilerTarget } from '../core/build-graph/generated/compiler-target';
import { createNativeSemanticContext } from '../core/typescript-semantic/native-semantic-factory';
import { resolveModuleWithOrigin } from '../core/typescript-semantic/resolution-origin';
import { createWorkspaceSourceBoundary } from '../core/typescript-semantic/workspace-source-boundary';
import { withFixtureGovernanceRoot } from './helpers/governance-root';
import { readFixtureSourceCoverage } from './helpers/native-coverage';
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
    'uses the same target and actual closure as TypeScript for $name',
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
        const projection = parseTypeScriptCommandLine({
          parseOptions: { configPath, projectRootDir: fixture.rootDir },
        });
        expect(
          projection.configClosure.map(({ filePath }) => filePath),
        ).toEqual([fixture.path(source), configPath].sort(compareCodeUnits));
        expect(
          inspectFrameworkIntent({ configPath, configObject: raw }),
        ).toEqual([]);
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
    } finally {
      await fixture.cleanup();
    }
  });
  it('preserves compiler paths and package-scope output remapping through Checker config caching and Native resolution', async () => {
    const fixture = await createFixture({
      'config/base.json': {
        compilerOptions: {
          rootDir: '../pkg/src',
          noLib: true,
          types: [],
          outDir: '../pkg/dist',
          module: 'NodeNext',
          paths: { alias: ['./alias.ts'] },
        },
      },
      'config/alias.ts': {},
      'pkg/package.json': {
        name: 'receiver',
        type: 'module',
        imports: { '#self': './dist/inner.d.ts' },
      },
      'pkg/src/inner.ts': {},
      'pkg/src/main.ts': {},
      'pkg/tsconfig.json': {
        extends: '../config/base.json',
        include: ['src/**/*.ts'],
      },
      'tsconfig.json': {
        extends: './config/base.json',
        files: ['pkg/src/main.ts', 'pkg/src/inner.ts'],
      },
    });
    try {
      const configPath = fixture.path('tsconfig.json');
      const containing = fixture.path('pkg/src/main.ts');
      const sourcePath = fixture.path('pkg/src/inner.ts');
      await writeFile(sourcePath, 'export type Value = number;');
      await writeFile(
        containing,
        "import type { Value } from '#self'; export type Local = Value;",
      );
      const scope = (options: ts.CompilerOptions, isTraced = false) =>
        ['#self', 'alias'].map(
          (name) =>
            (isTraced
              ? resolveModuleWithOrigin(ts, name, containing, options, ts.sys)
              : ts.resolveModuleName(name, containing, options, ts.sys)
            ).resolvedModule?.resolvedFileName,
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
      expect(scope({ ...reference.options })[0]).toBe(sourcePath);
      const parse = (
        file = configPath,
        cache = new CheckerProjectConfigCache(),
      ) =>
        parseCheckerProjectConfigForContext({
          configPath: file,
          projectRootDir: fixture.rootDir,
          context: { checkerPresets: ['tsc'], extensions: [] },
          cache,
        });
      const previous = new InvocationConfigReads(emptyMetrics());
      const checkerCache = new CheckerProjectConfigCache();
      expect(
        scope(
          previous.run(() => parse(configPath, checkerCache)).options,
          true,
        ),
      ).toEqual(expected);
      expect(
        scope(
          previous.run(() => parse(configPath, checkerCache)).options,
          true,
        ),
      ).toEqual(expected);
      const localConfig = fixture.path('pkg/tsconfig.json');
      const local = previous.run(() => parse(localConfig));
      expect(local.fileNames).toEqual([sourcePath, containing]);
      expect(scope(local.options, true)).toEqual([
        sourcePath,
        fixture.path('config/alias.ts'),
      ]);
      const resolveInBoundedProgram = (file: string) => {
        const parsed = parse(file);
        const context = createNativeSemanticContext({
          configPath: file,
          fileNames: parsed.fileNames,
          options: parsed.options,
          projectReferences: parsed.projectReferences,
          workspaceSourceBoundary: createWorkspaceSourceBoundary(
            parsed.fileNames,
            undefined,
            readFixtureSourceCoverage([file]),
          ),
        });
        try {
          return context.resolveImportRecord(
            context.getImportRecords(containing)[0]!,
          ).target;
        } finally {
          context.dispose();
        }
      };
      expect(resolveInBoundedProgram(configPath)).toBeNull();
      expect(resolveInBoundedProgram(localConfig)).toMatchObject({
        resolvedFileName: sourcePath,
      });
      const metrics = emptyMetrics();
      const current = new InvocationConfigReads(metrics);
      const renamed = fixture.path('pkg/src/replacement.ts');
      await rename(sourcePath, renamed);
      const config = current.run(() => parse(localConfig));
      expect(config.fileNames).toEqual([containing, renamed]);
      expect(scope(config.options, true)).toEqual(expected);
      expect(metrics).toMatchObject({
        resolvedConfigParses: 1,
      });
    } finally {
      await fixture.cleanup();
    }
  });
});
