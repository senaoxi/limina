import { resolveModuleNameWithOxc } from '#core/import-analysis/runner';
import {
  collectImportsFromFile,
  createImportAnalysisContext,
  resolveInternalImport,
} from '#core/import-graph/context';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
  collectTypeScriptImports,
  collectTypeScriptSourceFileImports,
} from '../core/import-analysis/typescript-imports';
import { createProfilingMetricsRecorder } from '../profiling/metrics';
import { toPortablePath } from './helpers/path';

async function createTempDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), 'limina-import-analysis-'));
}

async function writeText(rootDir: string, filePath: string, text: string) {
  const absolutePath = path.join(rootDir, filePath);

  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, text);

  return absolutePath;
}

describe('import analysis', () => {
  it('uses the injected TypeScript module for AST, scanner, and CommonJS enumeration', () => {
    const isImportDeclaration = vi.fn(ts.isImportDeclaration);
    const createScanner = vi.fn(ts.createScanner);
    const forEachChild = vi.fn(ts.forEachChild);
    const tsModule = {
      ...ts,
      createScanner,
      forEachChild,
      isImportDeclaration,
    } as unknown as typeof ts;
    const sourceFile = tsModule.createSourceFile(
      '/generated/App.vue.ts',
      [
        '/** @type {import("./types").Types} */',
        "import './esm';",
        "require('./commonjs');",
      ].join('\n'),
      tsModule.ScriptTarget.Latest,
      true,
      tsModule.ScriptKind.TS,
    );

    expect(
      collectTypeScriptSourceFileImports({
        filePath: sourceFile.fileName,
        sourceFile,
        tsModule,
      }).map(({ kind, specifier }) => ({ kind, specifier })),
    ).toEqual([
      { kind: 'jsdoc-import', specifier: './types' },
      { kind: 'static', specifier: './esm' },
      { kind: 'commonjs', specifier: './commonjs' },
    ]);
    expect(isImportDeclaration).toHaveBeenCalled();
    expect(forEachChild).toHaveBeenCalled();
    expect(createScanner).toHaveBeenCalled();
  });

  it('keeps full UTF-16 string-token locators and duplicate occurrences stable', async () => {
    const rootDir = await createTempDir();
    const sourceText = [
      "const label = '資源😀';",
      "import './shared.css';",
      "import './shared.css';",
      "void import('./shared.css');",
      "type Shared = import('./shared.css').Shared;",
      '',
    ].join('\r\n');

    try {
      const filePath = await writeText(rootDir, 'src/locator.ts', sourceText);
      const imports = collectImportsFromFile(filePath, rootDir).filter(
        (record) => record.specifier === './shared.css',
      );

      expect(
        imports.map((record) => ({
          kind: record.kind,
          occurrence: record.locator.occurrence,
          token: sourceText.slice(
            record.locator.sourceStart,
            record.locator.sourceEnd,
          ),
        })),
      ).toEqual([
        { kind: 'static', occurrence: 0, token: "'./shared.css'" },
        { kind: 'static', occurrence: 1, token: "'./shared.css'" },
        { kind: 'dynamic', occurrence: 0, token: "'./shared.css'" },
        { kind: 'import-type', occurrence: 0, token: "'./shared.css'" },
      ]);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('collects static, type, export-from, dynamic, and import-type dependencies', async () => {
    const rootDir = await createTempDir();

    try {
      const filePath = await writeText(
        rootDir,
        'src/index.tsx',
        [
          "import value from './value';",
          "import type { TypeValue } from './types';",
          "export { otherValue } from './other';",
          "void import('./lazy');",
          "export type Imported = import('./import-type').Imported;",
          'export const all = [value, TypeValue, otherValue];',
        ].join('\n'),
      );

      expect(
        collectImportsFromFile(filePath, rootDir).map((item) => ({
          kind: item.kind,
          line: item.line,
          specifier: item.specifier,
        })),
      ).toEqual([
        { kind: 'static', line: 1, specifier: './value' },
        { kind: 'import-type', line: 2, specifier: './types' },
        { kind: 'export', line: 3, specifier: './other' },
        { kind: 'dynamic', line: 4, specifier: './lazy' },
        { kind: 'import-type', line: 5, specifier: './import-type' },
      ]);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('emits one export record per source literal and preserves statement occurrences', async () => {
    const rootDir = await createTempDir();
    const sourceText = [
      "export { first, second } from './shared';",
      "export { third } from './shared';",
      '',
    ].join('\n');

    try {
      const filePath = await writeText(rootDir, 'src/reexports.ts', sourceText);

      expect(
        collectImportsFromFile(filePath, rootDir).map((record) => ({
          kind: record.kind,
          occurrence: record.locator.occurrence,
          specifier: record.specifier,
          token: sourceText.slice(
            record.locator.sourceStart,
            record.locator.sourceEnd,
          ),
        })),
      ).toEqual([
        {
          kind: 'export',
          occurrence: 0,
          specifier: './shared',
          token: "'./shared'",
        },
        {
          kind: 'export',
          occurrence: 1,
          specifier: './shared',
          token: "'./shared'",
        },
      ]);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('collects import types from declaration files', async () => {
    const rootDir = await createTempDir();

    try {
      const filePath = await writeText(
        rootDir,
        'src/import-type.d.ts',
        "export type VueModule = typeof import('vue');\n",
      );

      expect(
        collectImportsFromFile(filePath, rootDir).map((record) => ({
          kind: record.kind,
          specifier: record.specifier,
        })),
      ).toEqual([{ kind: 'import-type', specifier: 'vue' }]);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('collects CommonJS, require.resolve, import-equals, and literal template dependencies', async () => {
    const rootDir = await createTempDir();

    try {
      const filePath = await writeText(
        rootDir,
        'src/commonjs.ts',
        [
          "import Equal = require('./equal');",
          "const cjs = require('./cjs');",
          'const cjsTemplate = require(`./cjs-template`);',
          "const resolved = require.resolve('./resolved');",
          'const resolvedTemplate = require.resolve(`./resolved-template`);',
          'void import(`./lazy-template`);',
          'void import(`./${name}`);',
          'const computed = require(name);',
          "const concatenated = require('./' + name);",
          "const computedResolve = require['resolve']('./computed');",
          'void [Equal, cjs, cjsTemplate, resolved, resolvedTemplate];',
          'void [computed, concatenated, computedResolve];',
        ].join('\n'),
      );

      expect(
        collectImportsFromFile(filePath, rootDir).map((item) => ({
          kind: item.kind,
          line: item.line,
          specifier: item.specifier,
        })),
      ).toEqual([
        { kind: 'import-equals', line: 1, specifier: './equal' },
        { kind: 'commonjs', line: 2, specifier: './cjs' },
        { kind: 'commonjs', line: 3, specifier: './cjs-template' },
        { kind: 'require-resolve', line: 4, specifier: './resolved' },
        {
          kind: 'require-resolve',
          line: 5,
          specifier: './resolved-template',
        },
        { kind: 'dynamic', line: 6, specifier: './lazy-template' },
      ]);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('collects only unshadowed require bindings and direct immutable createRequire aliases', () => {
    const sourceText = [
      "import { createRequire as makeRequire } from 'node:module';",
      'const local = makeRequire(import.meta.url);',
      "const direct = require('./global');",
      "const resolved = require.resolve('./global-resolved');",
      "const localValue = local('./local');",
      "const localResolved = local.resolve('./local-resolved');",
      "{ const require = () => null; require('./block-shadow'); }",
      "function parameter(require: (id: string) => unknown) { require('./parameter-shadow'); }",
      "function nested() { const local = () => null; local('./nested-shadow'); }",
      "const transitive = local; transitive('./transitive');",
      "const { resolve } = local; resolve('./destructured');",
      "require['resolve']('./computed');",
      "require?.('./optional');",
      "(0, require)('./indirect');",
      'void [direct, resolved, localValue, localResolved, parameter, nested];',
    ].join('\n');
    const options = {
      filePath: '/fixture/imports.ts',
      scriptKind: ts.ScriptKind.TS,
      sourceText,
    };
    const expected = [
      ['commonjs', './global'],
      ['require-resolve', './global-resolved'],
      ['commonjs', './local'],
      ['require-resolve', './local-resolved'],
    ];

    expect(
      collectTypeScriptImports(options)
        .filter((record) =>
          ['commonjs', 'require-resolve'].includes(record.kind),
        )
        .map((record) => [record.kind, record.specifier]),
    ).toEqual(expected);
  });

  it('excludes imported, declared, and reassigned require bindings during tolerant TypeScript parsing', () => {
    const validSource = [
      "import { require } from './shim';",
      "require('./import-shadow');",
      'function require() {}',
      "require.resolve('./function-shadow');",
    ].join('\n');
    const fallbackSource = [
      "import { createRequire } from 'node:module';",
      'const local = createRequire(import.meta.url);',
      "local('./before-reassignment');",
      'local = replacement;',
      "local.resolve('./after-reassignment');",
      'const = ;',
    ].join('\n');

    expect(
      collectTypeScriptImports({
        filePath: '/fixture/shadowed.ts',
        scriptKind: ts.ScriptKind.TS,
        sourceText: validSource,
      }).filter((record) =>
        ['commonjs', 'require-resolve'].includes(record.kind),
      ),
    ).toEqual([]);
    expect(
      collectTypeScriptImports({
        filePath: '/fixture/fallback.ts',
        scriptKind: ts.ScriptKind.TS,
        sourceText: fallbackSource,
      }).filter((record) =>
        ['commonjs', 'require-resolve'].includes(record.kind),
      ),
    ).toEqual([]);
  });

  it('collects dependency pragmas from comments', async () => {
    const rootDir = await createTempDir();

    try {
      const filePath = await writeText(
        rootDir,
        'src/comments.ts',
        [
          '/**',
          ' * @type {import("./jsdoc").Thing}',
          ' * @import { Tagged } from "./tagged"',
          ' * @jsxImportSource @emotion/react',
          ' */',
          '// @jest-environment jsdom',
          '// @vitest-environment edge-runtime',
          '// @jest-environment node',
          '/// <reference types="vitest" />',
          '/// <reference path="./ambient.d.ts" />',
          'const value = 1;',
          '// @vitest-environment happy-dom',
          'export { value };',
        ].join('\n'),
      );

      expect(
        collectImportsFromFile(filePath, rootDir).map((item) => ({
          kind: item.kind,
          line: item.line,
          specifier: item.specifier,
        })),
      ).toEqual([
        { kind: 'jsdoc-import', line: 2, specifier: './jsdoc' },
        { kind: 'jsdoc-import', line: 3, specifier: './tagged' },
        { kind: 'jsx-import-source', line: 4, specifier: '@emotion/react' },
        {
          kind: 'environment-pragma',
          line: 6,
          specifier: 'jest-environment-jsdom',
        },
        { kind: 'environment-pragma', line: 7, specifier: '@edge-runtime/vm' },
        { kind: 'triple-slash-types', line: 9, specifier: 'vitest' },
        { kind: 'triple-slash-path', line: 10, specifier: './ambient.d.ts' },
      ]);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it.each(['App.vue', 'Page.astro', 'Widget.svelte'])(
    'rejects standalone framework source %s with a stable project-context error',
    async (name) => {
      const rootDir = await createTempDir();
      try {
        const filePath = await writeText(rootDir, name, 'export {}\n');
        expect(() => collectImportsFromFile(filePath, rootDir)).toThrow(
          'Framework source requires project/checker context; use getResolvedImports(file, project).',
        );
      } finally {
        await rm(rootDir, { force: true, recursive: true });
      }
    },
  );

  it('rejects an explicit framework source profile on the standalone API', async () => {
    const rootDir = await createTempDir();
    try {
      const filePath = await writeText(rootDir, 'Page.md', '# Page\n');
      expect(() =>
        collectImportsFromFile(
          filePath,
          rootDir,
          undefined,
          'vitepress-markdown',
        ),
      ).toThrow(
        'Framework source requires project/checker context; use getResolvedImports(file, project).',
      );
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('collects imports from files with recoverable TypeScript syntax errors', async () => {
    const rootDir = await createTempDir();

    try {
      const filePath = await writeText(
        rootDir,
        'src/broken.ts',
        [
          "import value from './value';",
          "const cjs = require('./cjs');",
          "const resolved = require.resolve('./resolved');",
          "import Equal = require('./equal');",
          'const = ;',
          'export const kept = value;',
        ].join('\n'),
      );

      expect(
        collectImportsFromFile(filePath, rootDir).map((item) => ({
          kind: item.kind,
          specifier: item.specifier,
        })),
      ).toEqual([
        { kind: 'static', specifier: './value' },
        { kind: 'commonjs', specifier: './cjs' },
        { kind: 'require-resolve', specifier: './resolved' },
        { kind: 'import-equals', specifier: './equal' },
      ]);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('resolves paths aliases, Vue extensionless imports, and package imports through the shared context', async () => {
    const rootDir = await createTempDir();

    try {
      const indexPath = await writeText(
        rootDir,
        'src/index.ts',
        [
          "import App from './App';",
          "import { aliased } from '@internal/aliased';",
          "import { packageImported } from '#package-import';",
          "import { shared } from 'shared';",
          'void App;',
          'void aliased;',
          'void packageImported;',
          'void shared;',
        ].join('\n'),
      );
      const appPath = await writeText(rootDir, 'src/App.vue', '<script />\n');
      const aliasedPath = await writeText(
        rootDir,
        'src/internal/aliased.ts',
        'export const aliased = 1;\n',
      );
      const packageImportPath = await writeText(
        rootDir,
        'src/package-import.ts',
        'export const packageImported = 1;\n',
      );
      const sharedPath = await writeText(
        rootDir,
        'shared.ts',
        'export const shared = 1;\n',
      );

      await writeText(
        rootDir,
        'package.json',
        JSON.stringify({
          imports: {
            '#package-import': './src/package-import.ts',
          },
          type: 'module',
        }),
      );
      const configPath = await writeText(
        rootDir,
        'tsconfig.json',
        JSON.stringify({
          compilerOptions: {},
        }),
      );
      await writeText(
        rootDir,
        'node_modules/shared/package.json',
        JSON.stringify({
          name: 'shared',
          types: './index.d.ts',
        }),
      );
      await writeText(
        rootDir,
        'node_modules/shared/index.d.ts',
        'export declare const shared: number;\n',
      );

      const context = createImportAnalysisContext();
      const compilerOptions = {
        baseUrl: rootDir,
        moduleResolution: 99,
        paths: {
          '@internal/*': ['src/internal/*'],
        },
      };
      const checkerContext = {
        checkerPresets: [],
        configPath,
        extensions: ['.ts', '.tsx', '.js', '.jsx', '.vue'],
      };

      expect(
        toPortablePath(
          resolveInternalImport(
            './App',
            indexPath,
            compilerOptions,
            checkerContext,
            context,
          ) ?? '',
        ),
      ).toBe(toPortablePath(appPath));
      expect(
        toPortablePath(
          resolveInternalImport(
            '@internal/aliased',
            indexPath,
            compilerOptions,
            checkerContext,
            context,
          ) ?? '',
        ),
      ).toBe(toPortablePath(aliasedPath));
      expect(
        toPortablePath(
          resolveInternalImport(
            '#package-import',
            indexPath,
            compilerOptions,
            checkerContext,
            context,
          ) ?? '',
        ),
      ).toBe(toPortablePath(packageImportPath));
      expect(
        toPortablePath(
          resolveInternalImport(
            'shared',
            indexPath,
            compilerOptions,
            checkerContext,
            context,
          ) ?? '',
        ),
      ).toBe(toPortablePath(sharedPath));
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('falls back to TypeScript resolution for module suffixes', async () => {
    const rootDir = await createTempDir();

    try {
      const indexPath = await writeText(
        rootDir,
        'src/index.ts',
        "import { feature } from './feature';\nvoid feature;\n",
      );
      await writeText(
        rootDir,
        'src/feature.ts',
        'export const feature = "default";\n',
      );
      const nativeFeaturePath = await writeText(
        rootDir,
        'src/feature.native.ts',
        'export const feature = "native";\n',
      );

      expect(
        toPortablePath(
          resolveInternalImport(
            './feature',
            indexPath,
            { moduleSuffixes: ['.native', ''] },
            {
              checkerPresets: [],
              extensions: ['.ts'],
            },
            createImportAnalysisContext(),
          ) ?? '',
        ),
      ).toBe(toPortablePath(nativeFeaturePath));
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('uses compiler custom conditions when resolving package exports with Oxc', async () => {
    const rootDir = await createTempDir();

    try {
      const indexPath = await writeText(
        rootDir,
        'src/index.ts',
        "import { value } from 'conditional';\nvoid value;\n",
      );
      const sourcePath = await writeText(
        rootDir,
        'node_modules/conditional/src/index.ts',
        'export const value = "source";\n',
      );
      const distPath = await writeText(
        rootDir,
        'node_modules/conditional/dist/index.js',
        'export const value = "dist";\n',
      );

      await writeText(
        rootDir,
        'node_modules/conditional/package.json',
        JSON.stringify({
          exports: {
            '.': {
              source: './src/index.ts',
              default: './dist/index.js',
            },
          },
          name: 'conditional',
          type: 'module',
        }),
      );
      const configPath = await writeText(
        rootDir,
        'tsconfig.json',
        JSON.stringify({
          compilerOptions: {},
        }),
      );

      const context = createImportAnalysisContext();
      const bundlerCompilerOptions = {
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      };
      const checkerContext = {
        checkerPresets: [],
        configPath,
        extensions: ['.ts', '.js'],
      };

      expect(
        toPortablePath(
          resolveInternalImport(
            'conditional',
            indexPath,
            bundlerCompilerOptions,
            checkerContext,
            context,
          ) ?? '',
        ),
      ).toBe(toPortablePath(distPath));
      expect(
        toPortablePath(
          resolveInternalImport(
            'conditional',
            indexPath,
            {
              ...bundlerCompilerOptions,
              customConditions: ['source'],
            },
            checkerContext,
            context,
          ) ?? '',
        ),
      ).toBe(toPortablePath(sourcePath));
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('keeps JavaScript package entry extensions in Oxc runtime resolution', async () => {
    const rootDir = await createTempDir();

    try {
      const indexPath = await writeText(
        rootDir,
        'src/index.ts',
        "import value from 'lodash.kebabcase';\nvoid value;\n",
      );
      const packageEntryPath = await writeText(
        rootDir,
        'node_modules/lodash.kebabcase/index.js',
        'module.exports = value => value;\n',
      );
      await writeText(
        rootDir,
        'node_modules/lodash.kebabcase/package.json',
        JSON.stringify({
          main: './index.js',
          name: 'lodash.kebabcase',
        }),
      );
      const configPath = await writeText(
        rootDir,
        'tsconfig.json',
        JSON.stringify({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
          },
        }),
      );

      expect(
        toPortablePath(
          resolveModuleNameWithOxc({
            compilerOptions: {
              module: ts.ModuleKind.ESNext,
              moduleResolution: ts.ModuleResolutionKind.Bundler,
            },
            containingFile: indexPath,
            context: {
              checkerPresets: ['tsc'],
              configPath,
              extensions: ['.ts', '.tsx', '.d.ts'],
            },
            specifier: 'lodash.kebabcase',
          }) ?? '',
        ),
      ).toBe(toPortablePath(packageEntryPath));
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('uses legacy package lookup for node10 instead of package exports conditions', async () => {
    const rootDir = await createTempDir();

    try {
      const indexPath = await writeText(
        rootDir,
        'src/index.ts',
        "import { value } from 'legacy-conditional';\nvoid value;\n",
      );
      await writeText(
        rootDir,
        'node_modules/legacy-conditional/src/index.ts',
        'export const value = "source";\n',
      );
      await writeText(
        rootDir,
        'node_modules/legacy-conditional/dist/export.js',
        'export const value = "export";\n',
      );
      const mainPath = await writeText(
        rootDir,
        'node_modules/legacy-conditional/dist/main.js',
        'export const value = "main";\n',
      );

      await writeText(
        rootDir,
        'node_modules/legacy-conditional/package.json',
        JSON.stringify({
          exports: {
            '.': {
              source: './src/index.ts',
              default: './dist/export.js',
            },
          },
          main: './dist/main.js',
          name: 'legacy-conditional',
          type: 'module',
        }),
      );
      const configPath = await writeText(
        rootDir,
        'tsconfig.json',
        JSON.stringify({
          compilerOptions: {
            moduleResolution: 'node10',
          },
        }),
      );
      const node10CompilerOptions = {
        customConditions: ['source'],
        moduleResolution: ts.ModuleResolutionKind.Node10,
      };
      const checkerContext = {
        checkerPresets: [],
        configPath,
        extensions: ['.ts', '.js'],
      };

      expect(
        toPortablePath(
          resolveModuleNameWithOxc({
            compilerOptions: node10CompilerOptions,
            containingFile: indexPath,
            context: checkerContext,
            specifier: 'legacy-conditional',
          }) ?? '',
        ),
      ).toBe(toPortablePath(mainPath));

      expect(
        toPortablePath(
          resolveInternalImport(
            'legacy-conditional',
            indexPath,
            node10CompilerOptions,
            checkerContext,
            createImportAnalysisContext(),
          ) ?? '',
        ),
      ).toBe(toPortablePath(mainPath));
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('uses explicit Oxc tsconfig paths without sharing resolver cache entries', async () => {
    const rootDir = await createTempDir();

    try {
      const indexPath = await writeText(
        rootDir,
        'src/index.ts',
        "import { value } from '@target';\nvoid value;\n",
      );
      const firstPath = await writeText(
        rootDir,
        'first.ts',
        'export const value = "first";\n',
      );
      const secondPath = await writeText(
        rootDir,
        'second.ts',
        'export const value = "second";\n',
      );
      const firstConfigPath = await writeText(
        rootDir,
        'tsconfig.first.json',
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: {
              '@target': ['./first.ts'],
            },
          },
        }),
      );
      const secondConfigPath = await writeText(
        rootDir,
        'tsconfig.second.json',
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: {
              '@target': ['./second.ts'],
            },
          },
        }),
      );
      const context = createImportAnalysisContext();

      expect(
        toPortablePath(
          resolveInternalImport(
            '@target',
            indexPath,
            {},
            {
              checkerPresets: [],
              configPath: firstConfigPath,
              extensions: ['.ts'],
            },
            context,
          ) ?? '',
        ),
      ).toBe(toPortablePath(firstPath));
      expect(
        toPortablePath(
          resolveInternalImport(
            '@target',
            indexPath,
            {},
            {
              checkerPresets: [],
              configPath: secondConfigPath,
              extensions: ['.ts'],
            },
            context,
          ) ?? '',
        ),
      ).toBe(toPortablePath(secondPath));
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('prefers the resolver config path over the graph config path for Oxc', async () => {
    const rootDir = await createTempDir();

    try {
      const indexPath = await writeText(
        rootDir,
        'src/index.ts',
        "import { value } from '@target';\nvoid value;\n",
      );
      const companionPath = await writeText(
        rootDir,
        'companion.ts',
        'export const value = "companion";\n',
      );
      await writeText(rootDir, 'dts.ts', 'export const value = "dts";\n');
      const dtsConfigPath = await writeText(
        rootDir,
        'tsconfig.lib.dts.json',
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: {
              '@target': ['./dts.ts'],
            },
          },
        }),
      );
      const companionConfigPath = await writeText(
        rootDir,
        'tsconfig.lib.json',
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: {
              '@target': ['./companion.ts'],
            },
          },
        }),
      );

      expect(
        toPortablePath(
          resolveInternalImport(
            '@target',
            indexPath,
            {},
            {
              checkerPresets: [],
              configPath: dtsConfigPath,
              extensions: ['.ts'],
              resolverConfigPath: companionConfigPath,
            },
            createImportAnalysisContext(),
          ) ?? '',
        ),
      ).toBe(toPortablePath(companionPath));
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('throws when Oxc resolution is missing an importer tsconfig configPath', async () => {
    const rootDir = await createTempDir();

    try {
      const indexPath = await writeText(
        rootDir,
        'src/index.ts',
        "import { value } from 'missing';\nvoid value;\n",
      );

      expect(() =>
        resolveModuleNameWithOxc({
          compilerOptions: {},
          containingFile: indexPath,
          context: {
            checkerPresets: [],
            extensions: ['.ts'],
          },
          specifier: 'missing',
        }),
      ).toThrow(/Oxc resolution requires the importer tsconfig configPath/u);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('keeps import collection caches private to an analysis context', async () => {
    const rootDir = await createTempDir();

    try {
      const filePath = await writeText(
        rootDir,
        'src/index.ts',
        "import { first } from './first';\nvoid first;\n",
      );

      const metrics = createProfilingMetricsRecorder();
      const context = createImportAnalysisContext({ metrics });

      expect(
        context
          .collectImportsFromFile(filePath, rootDir)
          .map((item) => item.specifier),
      ).toEqual(['./first']);

      await writeText(
        rootDir,
        'src/index.ts',
        "import { second } from './second';\nvoid second;\n",
      );

      expect(
        context
          .collectImportsFromFile(filePath, rootDir)
          .map((item) => item.specifier),
      ).toEqual(['./first']);
      expect(
        createImportAnalysisContext()
          .collectImportsFromFile(filePath, rootDir)
          .map((item) => item.specifier),
      ).toEqual(['./second']);

      const snapshot = metrics.snapshot();
      const metricCount = (name: string, kind?: string): number =>
        snapshot.find(
          (metric) =>
            metric.name === name &&
            (kind === undefined || metric.kind === kind),
        )?.count ?? 0;
      expect(metricCount('source-read')).toBe(1);
      expect(metricCount('source-parse')).toBe(1);
      expect(metricCount('provider-cache-miss', 'imports')).toBe(1);
      expect(metricCount('provider-cache-hit', 'imports')).toBe(1);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('keeps module resolution caches private to an analysis context', async () => {
    const rootDir = await createTempDir();

    try {
      const indexPath = await writeText(
        rootDir,
        'src/index.ts',
        "import { missing } from './missing';\nvoid missing;\n",
      );
      const configPath = await writeText(
        rootDir,
        'tsconfig.json',
        JSON.stringify({
          compilerOptions: {},
        }),
      );
      const compilerOptions = {};
      const checkerContext = {
        checkerPresets: [],
        configPath,
        extensions: ['.ts'],
      };
      const metrics = createProfilingMetricsRecorder();
      const context = createImportAnalysisContext({ metrics });

      expect(
        context.resolveInternalImport(
          './missing',
          indexPath,
          compilerOptions,
          checkerContext,
        ),
      ).toBeNull();

      const missingPath = await writeText(
        rootDir,
        'src/missing.ts',
        'export const missing = 1;\n',
      );

      expect(
        context.resolveInternalImport(
          './missing',
          indexPath,
          compilerOptions,
          checkerContext,
        ),
      ).toBeNull();

      const snapshot = metrics.snapshot();
      expect(
        snapshot.find(
          (metric) => metric.name === 'import-resolution-cache-miss',
        )?.count,
      ).toBe(1);
      expect(
        snapshot.find((metric) => metric.name === 'import-resolution-cache-hit')
          ?.count,
      ).toBe(1);

      expect(
        toPortablePath(
          resolveInternalImport(
            './missing',
            indexPath,
            compilerOptions,
            checkerContext,
          ) ?? '',
        ),
      ).toBe(toPortablePath(missingPath));
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });
});
