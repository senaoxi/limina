import { createImportAnalysisContext } from '#core/import-analysis/runner';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createDeclarationClassifier } from '../core/import-graph/declaration-classifier';
import { resolveDeclarationProvider } from '../core/import-graph/declaration-provider';
import { toPortablePath } from './helpers/path';

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

async function createFixture(files: Record<string, string>): Promise<{
  cleanup: () => Promise<void>;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-declaration-provider-')),
  );

  for (const [relativePath, text] of Object.entries(files)) {
    await writeText(path.join(rootDir, relativePath), text);
  }

  return {
    cleanup: async () => {
      await rm(rootDir, { force: true, recursive: true });
    },
    rootDir,
  };
}

describe('active TypeScript declaration classification', () => {
  it.each([
    'value.d.ts',
    'value.d.mts',
    'value.d.cts',
    'value.d.css.ts',
    'value.vue.d.ts',
    'value.css.d.ts',
  ])('classifies %s as a declaration', (fileName) => {
    const classifier = createDeclarationClassifier();

    expect(classifier.classify(path.join(process.cwd(), fileName))).toBe(true);
  });

  it('uses an existing Program SourceFile as the declaration authority', () => {
    const classifier = createDeclarationClassifier();
    const sourceFile = ts.createSourceFile(
      path.join(process.cwd(), 'value.d.css.ts'),
      'declare const value: string;\n',
      ts.ScriptTarget.Latest,
      false,
    );

    expect(sourceFile.isDeclarationFile).toBe(true);
    expect(classifier.classify(sourceFile.fileName, sourceFile)).toBe(true);
    expect(classifier.classify(path.join(process.cwd(), 'value.css.ts'))).toBe(
      false,
    );
  });

  it.each([
    {
      declarationPath: 'src/button.d.css.ts',
      expectedExternal: false,
      specifier: './button.css',
    },
    {
      declarationPath: 'node_modules/theme/button.d.css.ts',
      expectedExternal: true,
      specifier: 'theme/button.css',
    },
  ])(
    'keeps $declarationPath as concrete declaration evidence',
    async ({ declarationPath, expectedExternal, specifier }) => {
      const fixture = await createFixture({
        [declarationPath]:
          'declare const className: string;\nexport default className;\n',
        'node_modules/theme/package.json': JSON.stringify({
          name: 'theme',
          version: '1.0.0',
        }),
        'src/button.css': '.button {}\n',
        'src/index.ts': `import className from '${specifier}';\nvoid className;\n`,
      });
      const containingFile = path.join(fixture.rootDir, 'src/index.ts');
      const importRecord = {
        filePath: containingFile,
        kind: 'static' as const,
        line: 1,
        locator: {
          occurrence: 0,
          sourceEnd: specifier.length + 2,
          sourceStart: 0,
        },
        specifier,
      };

      try {
        const resolution = resolveDeclarationProvider({
          compilerOptions: {
            allowArbitraryExtensions: true,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
          },
          containingFile,
          fileOwnerLookup: new Map(),
          importAnalysis: createImportAnalysisContext({
            projectRootDir: fixture.rootDir,
          }),
          importRecord,
          project: {
            checkerPresets: ['tsc'],
            configPath: path.join(fixture.rootDir, 'tsconfig.json'),
            extensions: ['.ts', '.tsx', '.mts', '.cts'],
            resolverConfigPath: path.join(fixture.rootDir, 'tsconfig.json'),
          },
        });

        expect(resolution.kind).toBe('resource');
        expect(resolution.typeScriptResolution).toEqual({
          isExternalLibraryImport: expectedExternal,
          resolvedBy: 'typescript',
          resolvedFileName: toPortablePath(
            path.join(fixture.rootDir, declarationPath),
          ),
        });
      } finally {
        await fixture.cleanup();
      }
    },
  );
});
