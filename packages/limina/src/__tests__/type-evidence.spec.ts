import { createImportAnalysisContext } from '#core/import-analysis/runner';
import type { ProjectInfo } from '#core/import-graph/context';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { TypeEvidenceCore } from '../core/type-evidence';
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
    await mkdtemp(path.join(tmpdir(), 'limina-type-evidence-')),
  );

  for (const [relativePath, text] of Object.entries({
    'tsconfig.json': '{}\n',
    ...files,
  })) {
    await writeText(path.join(rootDir, relativePath), text);
  }

  return {
    cleanup: async () => {
      await rm(rootDir, { force: true, recursive: true });
    },
    rootDir,
  };
}

function createProject(options: {
  fileNames: string[];
  rootDir: string;
  types?: string[];
}): Pick<
  ProjectInfo,
  | 'checkerPresets'
  | 'configPath'
  | 'extensions'
  | 'fileNames'
  | 'options'
  | 'resolverConfigPath'
> {
  const configPath = path.join(options.rootDir, 'tsconfig.json');

  return {
    checkerPresets: ['tsc'],
    configPath,
    extensions: ['.ts', '.tsx', '.mts', '.cts'],
    fileNames: options.fileNames,
    options: {
      allowArbitraryExtensions: true,
      configFilePath: configPath,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      target: ts.ScriptTarget.ES2023,
      types: options.types ?? [],
    },
    resolverConfigPath: configPath,
  };
}

function createCore(rootDir: string): TypeEvidenceCore {
  return new TypeEvidenceCore({
    generation: 0,
    importAnalysis: createImportAnalysisContext({ projectRootDir: rootDir }),
  });
}

describe('TypeScript resource type evidence', () => {
  it('finds local ambient evidence and reuses one Program for duplicate imports', async () => {
    const fixture = await createFixture({
      'src/assets.d.ts': [
        "declare module '*.css' {",
        '  const className: string;',
        '  export default className;',
        '}',
        '',
      ].join('\n'),
      'src/index.ts': [
        "import './style.css';",
        "import './style.css';",
        '',
      ].join('\n'),
      'src/style.css': '.root {}\n',
    });
    const indexPath = path.join(fixture.rootDir, 'src/index.ts');
    const ambientPath = path.join(fixture.rootDir, 'src/assets.d.ts');
    const core = createCore(fixture.rootDir);
    const project = createProject({
      fileNames: [indexPath, ambientPath],
      rootDir: fixture.rootDir,
    });

    try {
      const imports = createImportAnalysisContext({
        projectRootDir: fixture.rootDir,
      }).collectImportsFromFile(indexPath, fixture.rootDir);
      const evidence = imports.map((importRecord) =>
        core.resolveImportEvidence({
          checkerName: 'typescript',
          importRecord,
          project,
        }),
      );

      expect(evidence.map((item) => item.type)).toEqual([
        {
          declarationFilePaths: [toPortablePath(ambientPath)],
          kind: 'ambient',
          modulePattern: '*.css',
        },
        {
          declarationFilePaths: [toPortablePath(ambientPath)],
          kind: 'ambient',
          modulePattern: '*.css',
        },
      ]);
      expect(core.cache.typeEvidenceProviderCache.size).toBe(1);
      expect(core.cache.programCache.size).toBe(1);
      expect(core.cache.importTypeEvidenceCache.size).toBe(2);
    } finally {
      core.dispose();
      await fixture.cleanup();
    }
  });

  it('loads vite/client ambient modules through the current Program types', async () => {
    const fixture = await createFixture({
      'node_modules/vite/client.d.ts': [
        "declare module '*.css' {",
        '  const className: string;',
        '  export default className;',
        '}',
        '',
      ].join('\n'),
      'node_modules/vite/package.json': JSON.stringify({
        name: 'vite',
        version: '1.0.0',
      }),
      'src/index.ts': "import './style.css';\n",
      'src/style.css': '.root {}\n',
    });
    const indexPath = path.join(fixture.rootDir, 'src/index.ts');
    const core = createCore(fixture.rootDir);
    const project = createProject({
      fileNames: [indexPath],
      rootDir: fixture.rootDir,
      types: ['vite/client'],
    });

    try {
      const [importRecord] = createImportAnalysisContext({
        projectRootDir: fixture.rootDir,
      }).collectImportsFromFile(indexPath, fixture.rootDir);

      expect(
        core.resolveImportEvidence({
          checkerName: 'typescript',
          importRecord: importRecord!,
          project,
        }).type,
      ).toEqual({
        declarationFilePaths: [
          toPortablePath(
            path.join(fixture.rootDir, 'node_modules/vite/client.d.ts'),
          ),
        ],
        kind: 'ambient',
        modulePattern: '*.css',
      });
    } finally {
      core.dispose();
      await fixture.cleanup();
    }
  });

  it('rejects ambient declarations that are not part of the current Program', async () => {
    const fixture = await createFixture({
      'src/excluded.d.ts': "declare module '*.css';\n",
      'src/index.ts': "import './style.css';\n",
      'src/style.css': '.root {}\n',
    });
    const indexPath = path.join(fixture.rootDir, 'src/index.ts');
    const core = createCore(fixture.rootDir);
    const project = createProject({
      fileNames: [indexPath],
      rootDir: fixture.rootDir,
    });

    try {
      const [importRecord] = createImportAnalysisContext({
        projectRootDir: fixture.rootDir,
      }).collectImportsFromFile(indexPath, fixture.rootDir);

      expect(
        core.resolveImportEvidence({
          checkerName: 'typescript',
          importRecord: importRecord!,
          project,
        }).type,
      ).toEqual({ kind: 'missing' });
    } finally {
      core.dispose();
      await fixture.cleanup();
    }
  });

  it.each([
    { cssExists: false, expectedRuntime: 'missing', withAmbient: true },
    { cssExists: true, expectedRuntime: 'file', withAmbient: false },
  ])(
    'keeps runtime $expectedRuntime independent from ambient=$withAmbient',
    async ({ cssExists, expectedRuntime, withAmbient }) => {
      const fixture = await createFixture({
        ...(withAmbient
          ? { 'src/assets.d.ts': "declare module '*.css';\n" }
          : {}),
        ...(cssExists ? { 'src/style.css': '.root {}\n' } : {}),
        'src/index.ts': "import './style.css';\n",
      });
      const indexPath = path.join(fixture.rootDir, 'src/index.ts');
      const ambientPath = path.join(fixture.rootDir, 'src/assets.d.ts');
      const core = createCore(fixture.rootDir);
      const project = createProject({
        fileNames: [indexPath, ...(withAmbient ? [ambientPath] : [])],
        rootDir: fixture.rootDir,
      });

      try {
        const [importRecord] = createImportAnalysisContext({
          projectRootDir: fixture.rootDir,
        }).collectImportsFromFile(indexPath, fixture.rootDir);
        const evidence = core.resolveImportEvidence({
          checkerName: 'typescript',
          importRecord: importRecord!,
          project,
        });

        expect(evidence.runtime.kind).toBe(expectedRuntime);
        expect(evidence.type.kind).toBe(withAmbient ? 'ambient' : 'missing');
      } finally {
        core.dispose();
        await fixture.cleanup();
      }
    },
  );

  it('resolves raw, url, worker, and exact ambient module symbols', async () => {
    const fixture = await createFixture({
      'src/assets.d.ts': [
        "declare module '*?raw';",
        "declare module '*?url';",
        "declare module '*?worker';",
        "declare module 'virtual:exact';",
        '',
      ].join('\n'),
      'src/index.ts': [
        "import './data.txt?raw';",
        "import './icon.svg?url';",
        "import './worker.ts?worker';",
        "import 'virtual:exact';",
        '',
      ].join('\n'),
      'src/data.txt': 'data\n',
      'src/icon.svg': '<svg />\n',
      'src/worker.ts': 'export {};\n',
    });
    const indexPath = path.join(fixture.rootDir, 'src/index.ts');
    const core = createCore(fixture.rootDir);
    const project = createProject({
      fileNames: [indexPath, path.join(fixture.rootDir, 'src/assets.d.ts')],
      rootDir: fixture.rootDir,
    });

    try {
      const imports = createImportAnalysisContext({
        projectRootDir: fixture.rootDir,
      }).collectImportsFromFile(indexPath, fixture.rootDir);
      const evidence = imports.map((importRecord) =>
        core.resolveImportEvidence({
          checkerName: 'typescript',
          importRecord,
          project,
        }),
      );

      expect(evidence.map((item) => item.type)).toEqual([
        expect.objectContaining({ modulePattern: '*?raw' }),
        expect.objectContaining({ modulePattern: '*?url' }),
        expect.objectContaining({ modulePattern: '*?worker' }),
        expect.objectContaining({ modulePattern: 'virtual:exact' }),
      ]);
      expect(core.cache.programCache.size).toBe(1);
    } finally {
      core.dispose();
      await fixture.cleanup();
    }
  });

  it('returns concrete arbitrary-extension declarations without a Program', async () => {
    const fixture = await createFixture({
      'src/button.css': '.button {}\n',
      'src/button.d.css.ts':
        'declare const value: string;\nexport default value;\n',
      'src/index.ts': "import value from './button.css';\nvoid value;\n",
    });
    const indexPath = path.join(fixture.rootDir, 'src/index.ts');
    const core = createCore(fixture.rootDir);
    const project = createProject({
      fileNames: [indexPath, path.join(fixture.rootDir, 'src/button.d.css.ts')],
      rootDir: fixture.rootDir,
    });

    try {
      const [importRecord] = createImportAnalysisContext({
        projectRootDir: fixture.rootDir,
      }).collectImportsFromFile(indexPath, fixture.rootDir);

      expect(
        core.resolveImportEvidence({
          checkerName: 'typescript',
          importRecord: importRecord!,
          project,
        }).type,
      ).toEqual({
        filePath: toPortablePath(
          path.join(fixture.rootDir, 'src/button.d.css.ts'),
        ),
        kind: 'concrete-declaration',
      });
      expect(core.cache.typeEvidenceProviderCache.size).toBe(0);
      expect(core.cache.programCache.size).toBe(0);
    } finally {
      core.dispose();
      await fixture.cleanup();
    }
  });
});
