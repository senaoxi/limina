import { resolveModuleNameWithOxc } from '#core/import-analysis/runner';
import {
  collectImportsFromFile,
  createImportAnalysisContext,
  resolveInternalImport,
} from '#core/import-graph/context';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { toPortablePath } from './helpers/path';

const requireFromTest = createRequire(import.meta.url);

async function createTempDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), 'limina-import-analysis-'));
}

async function writeText(rootDir: string, filePath: string, text: string) {
  const absolutePath = path.join(rootDir, filePath);

  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, text);

  return absolutePath;
}

async function linkCompilerSfc(rootDir: string): Promise<void> {
  const compilerPackagePath = requireFromTest.resolve(
    '@vue/compiler-sfc/package.json',
  );
  const nodeModulesDir = path.join(rootDir, 'node_modules', '@vue');

  await mkdir(nodeModulesDir, {
    recursive: true,
  });
  await symlink(
    path.dirname(compilerPackagePath),
    path.join(nodeModulesDir, 'compiler-sfc'),
    'dir',
  );
}

describe('import analysis', () => {
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
        { kind: 'comment', line: 2, specifier: './jsdoc' },
        { kind: 'comment', line: 3, specifier: './tagged' },
        { kind: 'comment', line: 4, specifier: '@emotion/react' },
        { kind: 'comment', line: 6, specifier: 'jest-environment-jsdom' },
        { kind: 'comment', line: 7, specifier: '@edge-runtime/vm' },
        { kind: 'comment', line: 9, specifier: 'vitest' },
        { kind: 'comment', line: 10, specifier: './ambient.d.ts' },
      ]);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('collects Vue inline script imports and skips src scripts', async () => {
    const rootDir = await createTempDir();

    try {
      const filePath = await writeText(
        rootDir,
        'src/App.vue',
        [
          '<template><div /></template>',
          '<script setup lang="ts" generic="T extends Record<string, value>">',
          "import value from './value';",
          "import Equal = require('./equal');",
          "const cjs = require('./cjs');",
          "const resolved = require.resolve('./resolved');",
          '// @jsxImportSource @emotion/react',
          "type Imported = import('./types').Imported;",
          '</script>',
          '<script src="./external.ts"></script>',
          '<script lang="tsx">',
          "export { Widget } from './Widget';",
          "void import('./lazy');",
          '</script>',
        ].join('\n'),
      );

      expect(
        collectImportsFromFile(filePath, rootDir).map((item) => ({
          kind: item.kind,
          line: item.line,
          specifier: item.specifier,
        })),
      ).toEqual([
        { kind: 'static', line: 3, specifier: './value' },
        { kind: 'import-equals', line: 4, specifier: './equal' },
        { kind: 'commonjs', line: 5, specifier: './cjs' },
        { kind: 'require-resolve', line: 6, specifier: './resolved' },
        { kind: 'comment', line: 7, specifier: '@emotion/react' },
        { kind: 'import-type', line: 8, specifier: './types' },
        { kind: 'export', line: 12, specifier: './Widget' },
        { kind: 'dynamic', line: 13, specifier: './lazy' },
      ]);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('collects Vue imports with the compiler-sfc parser when configured', async () => {
    const rootDir = await createTempDir();

    try {
      await linkCompilerSfc(rootDir);
      const filePath = await writeText(
        rootDir,
        'src/App.vue',
        [
          '<template><div /></template>',
          '<script setup lang="ts" generic="T extends Record<string, value>">',
          "import value from './value';",
          "import Equal = require('./equal');",
          "type Imported = import('./types').Imported;",
          '</script>',
          '<script lang="tsx">',
          "export { Widget } from './Widget';",
          "void import('./lazy');",
          '</script>',
        ].join('\n'),
      );
      const context = createImportAnalysisContext({
        projectRootDir: rootDir,
        vueParser: 'compiler-sfc',
      });

      expect(
        collectImportsFromFile(filePath, rootDir, context).map((item) => ({
          kind: item.kind,
          line: item.line,
          specifier: item.specifier,
        })),
      ).toEqual([
        { kind: 'static', line: 3, specifier: './value' },
        { kind: 'import-equals', line: 4, specifier: './equal' },
        { kind: 'import-type', line: 5, specifier: './types' },
        { kind: 'export', line: 8, specifier: './Widget' },
        { kind: 'dynamic', line: 9, specifier: './lazy' },
      ]);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('fails compiler-sfc Vue import analysis when the peer is missing', async () => {
    const rootDir = await createTempDir();

    try {
      const filePath = await writeText(
        rootDir,
        'src/App.vue',
        '<script setup lang="ts">import value from "./value";</script>\n',
      );
      const context = createImportAnalysisContext({
        projectRootDir: rootDir,
        vueParser: 'compiler-sfc',
      });

      expect(() => collectImportsFromFile(filePath, rootDir, context)).toThrow(
        /Unable to load Vue SFC compiler for import analysis/u,
      );
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('fails compiler-sfc Vue import analysis on SFC parse errors', async () => {
    const rootDir = await createTempDir();

    try {
      await linkCompilerSfc(rootDir);
      const filePath = await writeText(
        rootDir,
        'src/App.vue',
        [
          '<script setup lang="ts">import one from "./one";</script>',
          '<script setup lang="ts">import two from "./two";</script>',
        ].join('\n'),
      );
      const context = createImportAnalysisContext({
        projectRootDir: rootDir,
        vueParser: 'compiler-sfc',
      });

      expect(() => collectImportsFromFile(filePath, rootDir, context)).toThrow(
        /Unable to parse Vue SFC for import analysis/u,
      );
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('falls back to TypeScript import collection when OXC rejects a file', async () => {
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

      const context = createImportAnalysisContext();

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
      const context = createImportAnalysisContext();

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
