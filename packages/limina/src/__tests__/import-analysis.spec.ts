import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearImportAnalysisCache,
  collectImportsFromFile,
  createImportAnalysisContext,
  resolveInternalImport,
} from '../graph-context';

async function createTempDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), 'limina-import-analysis-'));
}

async function writeText(rootDir: string, filePath: string, text: string) {
  const absolutePath = path.join(rootDir, filePath);

  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, text);

  return absolutePath;
}

beforeEach(() => {
  clearImportAnalysisCache();
});

afterEach(() => {
  clearImportAnalysisCache();
});

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
          line: item.line,
          specifier: item.specifier,
        })),
      ).toEqual([
        { line: 1, specifier: './value' },
        { line: 2, specifier: './types' },
        { line: 3, specifier: './other' },
        { line: 4, specifier: './lazy' },
        { line: 5, specifier: './import-type' },
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
          line: item.line,
          specifier: item.specifier,
        })),
      ).toEqual([
        { line: 3, specifier: './value' },
        { line: 4, specifier: './types' },
        { line: 8, specifier: './Widget' },
        { line: 9, specifier: './lazy' },
      ]);
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
        "import value from './value';\nconst = ;\nexport const kept = value;\n",
      );

      expect(
        collectImportsFromFile(filePath, rootDir).map((item) => item.specifier),
      ).toEqual(['./value']);
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
        extensions: ['.ts', '.tsx', '.js', '.jsx', '.vue'],
      };

      expect(
        resolveInternalImport(
          './App',
          indexPath,
          compilerOptions,
          checkerContext,
          context,
        ),
      ).toBe(appPath);
      expect(
        resolveInternalImport(
          '@internal/aliased',
          indexPath,
          compilerOptions,
          checkerContext,
          context,
        ),
      ).toBe(aliasedPath);
      expect(
        resolveInternalImport(
          '#package-import',
          indexPath,
          compilerOptions,
          checkerContext,
          context,
        ),
      ).toBe(packageImportPath);
      expect(
        resolveInternalImport(
          'shared',
          indexPath,
          compilerOptions,
          checkerContext,
          context,
        ),
      ).toBe(sharedPath);
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
        resolveInternalImport(
          './feature',
          indexPath,
          { moduleSuffixes: ['.native', ''] },
          {
            checkerPresets: [],
            extensions: ['.ts'],
          },
          createImportAnalysisContext(),
        ),
      ).toBe(nativeFeaturePath);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('reuses shared import collection cache across default contexts', async () => {
    const rootDir = await createTempDir();

    try {
      const filePath = await writeText(
        rootDir,
        'src/index.ts',
        "import { first } from './first';\nvoid first;\n",
      );

      expect(
        collectImportsFromFile(filePath, rootDir).map((item) => item.specifier),
      ).toEqual(['./first']);

      await writeText(
        rootDir,
        'src/index.ts',
        "import { second } from './second';\nvoid second;\n",
      );

      expect(
        collectImportsFromFile(filePath, rootDir).map((item) => item.specifier),
      ).toEqual(['./first']);
      expect(
        createImportAnalysisContext({
          isolated: true,
        })
          .collectImportsFromFile(filePath, rootDir)
          .map((item) => item.specifier),
      ).toEqual(['./second']);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('reuses shared module resolution cache across default contexts', async () => {
    const rootDir = await createTempDir();

    try {
      const indexPath = await writeText(
        rootDir,
        'src/index.ts',
        "import { missing } from './missing';\nvoid missing;\n",
      );
      const compilerOptions = {};
      const extensions = ['.ts'];

      expect(
        resolveInternalImport(
          './missing',
          indexPath,
          compilerOptions,
          extensions,
        ),
      ).toBeNull();

      const missingPath = await writeText(
        rootDir,
        'src/missing.ts',
        'export const missing = 1;\n',
      );

      expect(
        resolveInternalImport(
          './missing',
          indexPath,
          compilerOptions,
          extensions,
        ),
      ).toBeNull();

      clearImportAnalysisCache();

      expect(
        resolveInternalImport(
          './missing',
          indexPath,
          compilerOptions,
          extensions,
        ),
      ).toBe(missingPath);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });
});
