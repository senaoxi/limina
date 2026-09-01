import { normalizeAbsolutePath } from '#utils/path';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceSourceBoundary } from '../core/typescript-semantic';
import { BoundedTypeScriptSemanticContext } from '../core/typescript-semantic/context';

const temporaryRoots: string[] = [];

async function createFixture(files: Record<string, string>): Promise<string> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-ts-semantic-')),
  );
  temporaryRoots.push(rootDir);
  for (const [relativePath, sourceText] of Object.entries(files)) {
    const filePath = path.join(rootDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, sourceText, 'utf8');
  }
  return rootDir;
}

function createContext(options: {
  fileNames: string[];
  options: ts.CompilerOptions;
  projectReferences?: readonly ts.ProjectReference[];
  rootDir: string;
  tsModule?: typeof ts;
  workspaceSourceFileNames?: string[];
}): BoundedTypeScriptSemanticContext {
  return new BoundedTypeScriptSemanticContext(
    {
      configPath: path.join(options.rootDir, 'tsconfig.json'),
      fileNames: options.fileNames,
      options: {
        configFilePath: path.join(options.rootDir, 'tsconfig.json'),
        ...options.options,
      },
      projectReferences: options.projectReferences,
      workspaceSourceBoundary: createWorkspaceSourceBoundary(
        options.workspaceSourceFileNames ?? options.fileNames,
      ),
    },
    options.tsModule,
  );
}

function findRecord(
  context: BoundedTypeScriptSemanticContext,
  fileName: string,
  kind: string,
) {
  return context
    .getImportRecords(fileName)
    .find((record) => record.kind === kind)!;
}

function parseConfig(configPath: string): ts.ParsedCommandLine {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      fileExists: ts.sys.fileExists,
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(String(diagnostic.messageText));
      },
      readDirectory: ts.sys.readDirectory,
      readFile: ts.sys.readFile,
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    },
  );
  if (parsed === undefined) throw new Error(`Unable to parse ${configPath}.`);
  return parsed;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((rootDir) => rm(rootDir, { force: true, recursive: true })),
  );
});

describe('bounded TypeScript semantic context', () => {
  it('preserves an explicit JSON project root admitted by checker extension authority', async () => {
    const rootDir = await createFixture({
      'src/data.json': '{"value":true}\n',
      'tsconfig.json': '{}\n',
    });
    const jsonFile = normalizeAbsolutePath(path.join(rootDir, 'src/data.json'));
    const context = createContext({
      fileNames: [jsonFile],
      options: {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        resolveJsonModule: true,
      },
      rootDir,
    });

    try {
      expect(context.project.fileNames).toContain(jsonFile);
      expect(context.program.getSourceFile(jsonFile)).toBeDefined();
    } finally {
      context.dispose();
    }
  });

  it('does not incidentally admit a resolved non-root JSON module', async () => {
    const rootDir = await createFixture({
      'src/data.json': '{"value":true}\n',
      'src/index.ts': "import data from './data.json';\nvoid data;\n",
      'tsconfig.json': '{}\n',
    });
    const sourceFile = path.join(rootDir, 'src/index.ts');
    const jsonFile = normalizeAbsolutePath(path.join(rootDir, 'src/data.json'));
    const context = createContext({
      fileNames: [sourceFile],
      options: {
        allowSyntheticDefaultImports: true,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        resolveJsonModule: true,
      },
      rootDir,
    });

    try {
      const record = findRecord(context, sourceFile, 'static');
      expect(context.resolveImportRecord(record).target?.resolvedFileName).toBe(
        jsonFile,
      );
      expect(context.program.getSourceFile(jsonFile)).toBeUndefined();
    } finally {
      context.dispose();
    }
  });

  it('blocks ordinary transitive source while retaining its physical ledger target', async () => {
    const rootDir = await createFixture({
      'src/index.ts': "import './internal';\n",
      'src/internal.ts': 'export const internal = true;\n',
      'tsconfig.json': '{}\n',
    });
    const sourceFile = path.join(rootDir, 'src/index.ts');
    const internalFile = normalizeAbsolutePath(
      path.join(rootDir, 'src/internal.ts'),
    );
    const context = createContext({
      fileNames: [sourceFile],
      options: {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      },
      rootDir,
    });

    try {
      const record = findRecord(context, sourceFile, 'static');
      expect(context.resolveImportRecord(record).target?.resolvedFileName).toBe(
        internalFile,
      );
      expect(context.program.getSourceFile(internalFile)).toBeUndefined();
    } finally {
      context.dispose();
    }
  });

  it('admits transitive declarations inside a resolved external package', async () => {
    const rootDir = await createFixture({
      'node_modules/pkg/index.d.ts': "export * from './internal';\n",
      'node_modules/pkg/internal.d.ts':
        'export declare const internal: true;\n',
      'node_modules/pkg/package.json': JSON.stringify({
        name: 'pkg',
        types: './index.d.ts',
        version: '1.0.0',
      }),
      'src/index.ts': "import { internal } from 'pkg';\nvoid internal;\n",
      'tsconfig.json': '{}\n',
    });
    const sourceFile = path.join(rootDir, 'src/index.ts');
    const internalFile = normalizeAbsolutePath(
      path.join(rootDir, 'node_modules/pkg/internal.d.ts'),
    );
    const context = createContext({
      fileNames: [sourceFile],
      options: {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      },
      rootDir,
    });

    try {
      expect(context.program.getSourceFile(internalFile)).toBeDefined();
    } finally {
      context.dispose();
    }
  });

  it.each([false, true])(
    'preserves external package admission with preserveSymlinks=%s',
    async (preserveSymlinks) => {
      const rootDir = await createFixture({
        'external/pkg/index.d.ts': 'export declare const value: true;\n',
        'external/pkg/package.json': JSON.stringify({
          name: 'pkg',
          types: './index.d.ts',
          version: '1.0.0',
        }),
        'node_modules/.keep': '',
        'src/index.ts': "import { value } from 'pkg';\nvoid value;\n",
        'tsconfig.json': '{}\n',
      });
      await symlink(
        path.join(rootDir, 'external/pkg'),
        path.join(rootDir, 'node_modules/pkg'),
        'dir',
      );
      const sourceFile = path.join(rootDir, 'src/index.ts');
      const context = createContext({
        fileNames: [sourceFile],
        options: {
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          preserveSymlinks,
        },
        rootDir,
      });

      try {
        const record = findRecord(context, sourceFile, 'static');
        const target = context.resolveImportRecord(record).target;
        expect(target?.isExternalLibraryImport).toBe(true);
        expect(
          context.program.getSourceFile(target!.resolvedFileName),
        ).toBeDefined();
      } finally {
        context.dispose();
      }
    },
  );

  it.each([false, true])(
    'blocks a governed workspace source reached through node_modules with preserveSymlinks=%s',
    async (preserveSymlinks) => {
      const rootDir = await createFixture({
        'A/node_modules/@workspace/.keep': '',
        'A/src/index.ts': [
          "import { value } from '@workspace/b';",
          'void value;',
          'void foreignGlobal;',
          '',
        ].join('\n'),
        'A/tsconfig.json': '{}\n',
        'B/package.json': JSON.stringify({
          exports: { '.': './src/index.ts' },
          name: '@workspace/b',
          type: 'module',
          version: '1.0.0',
        }),
        'B/src/env.d.ts': 'declare const foreignGlobal: true;\n',
        'B/src/index.ts': [
          '/// <reference path="./env.d.ts" />',
          'export const value = foreignGlobal;',
          '',
        ].join('\n'),
        'B/tsconfig.json': '{}\n',
      });
      await symlink(
        path.join(rootDir, 'B'),
        path.join(rootDir, 'A/node_modules/@workspace/b'),
        'dir',
      );
      const sourceFile = path.join(rootDir, 'A/src/index.ts');
      const foreignSource = normalizeAbsolutePath(
        path.join(rootDir, 'B/src/index.ts'),
      );
      const foreignEnvironment = normalizeAbsolutePath(
        path.join(rootDir, 'B/src/env.d.ts'),
      );
      const context = createContext({
        fileNames: [sourceFile],
        options: {
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          preserveSymlinks,
        },
        rootDir: path.join(rootDir, 'A'),
        workspaceSourceFileNames: [
          sourceFile,
          foreignSource,
          foreignEnvironment,
        ],
      });

      try {
        const record = findRecord(context, sourceFile, 'static');
        const target = context.resolveImportRecord(record).target;
        expect(target?.isExternalLibraryImport).toBe(true);
        expect(context.program.getSourceFile(target!.resolvedFileName)).toBe(
          undefined,
        );
        expect(context.program.getSourceFile(foreignSource)).toBeUndefined();
        expect(
          context.program.getSourceFile(foreignEnvironment),
        ).toBeUndefined();
        expect(
          context.program
            .getSemanticDiagnostics()
            .some(
              (diagnostic) =>
                diagnostic.code === 2304 &&
                String(diagnostic.messageText).includes('foreignGlobal'),
            ),
        ).toBe(true);
      } finally {
        context.dispose();
      }
    },
  );

  it('preserves raw project-reference admission instead of treating it as ordinary closure', async () => {
    const rootDir = await createFixture({
      'A/src/index.ts': [
        "import { value } from '../../B/src/index';",
        'void value;',
        '',
      ].join('\n'),
      'A/tsconfig.json': JSON.stringify({
        compilerOptions: {
          module: 'esnext',
          moduleResolution: 'bundler',
        },
        files: ['src/index.ts'],
        references: [{ path: '../B' }],
      }),
      'B/src/index.d.ts': 'export declare const value = true;\n',
      'B/src/index.ts': 'export const value = true;\n',
      'B/tsconfig.json': JSON.stringify({
        compilerOptions: { composite: true },
        include: ['src/index.ts'],
      }),
    });
    const sourceFile = path.join(rootDir, 'A/src/index.ts');
    const referencedFile = normalizeAbsolutePath(
      path.join(rootDir, 'B/src/index.ts'),
    );
    const referencedDeclaration = normalizeAbsolutePath(
      path.join(rootDir, 'B/src/index.d.ts'),
    );
    const compilerOptions = {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    };
    const parsed = parseConfig(path.join(rootDir, 'A/tsconfig.json'));
    const withoutReference = createContext({
      fileNames: [sourceFile],
      options: compilerOptions,
      rootDir: path.join(rootDir, 'A'),
    });
    const withReference = createContext({
      fileNames: [sourceFile],
      options: compilerOptions,
      projectReferences: parsed.projectReferences,
      rootDir: path.join(rootDir, 'A'),
    });

    try {
      expect(
        withoutReference.program.getSourceFile(referencedFile),
      ).toBeUndefined();
      const redirectedSourceFile =
        withReference.program.getSourceFile(referencedFile);
      expect(redirectedSourceFile?.fileName).toBe(referencedDeclaration);
      expect(withReference.program.getSourceFile(referencedDeclaration)).toBe(
        redirectedSourceFile,
      );
      expect(
        withReference.program.getResolvedProjectReferences()?.[0],
      ).toBeDefined();
    } finally {
      withoutReference.dispose();
      withReference.dispose();
    }
  });

  it('keeps NodeNext resolution occurrence- and mode-aware', async () => {
    const rootDir = await createFixture({
      'node_modules/dual/import.d.mts':
        'declare const value: "import"; export default value;\n',
      'node_modules/dual/import.js': 'export default "import";\n',
      'node_modules/dual/package.json': JSON.stringify({
        exports: {
          '.': {
            import: { default: './import.js', types: './import.d.mts' },
            require: { default: './require.cjs', types: './require.d.cts' },
          },
        },
        name: 'dual',
        type: 'module',
        version: '1.0.0',
      }),
      'node_modules/dual/require.cjs': 'module.exports = "require";\n',
      'node_modules/dual/require.d.cts':
        'declare const value: "require"; export = value;\n',
      'src/index.mts': [
        "import imported from 'dual';",
        "import required = require('dual');",
        'void imported;',
        'void required;',
        '',
      ].join('\n'),
      'tsconfig.json': '{}\n',
    });
    const sourceFile = path.join(rootDir, 'src/index.mts');
    const context = createContext({
      fileNames: [sourceFile],
      options: {
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        target: ts.ScriptTarget.ES2023,
      },
      rootDir,
    });

    try {
      const records = context
        .getImportRecords(sourceFile)
        .filter((record) => record.specifier === 'dual');
      const staticResolution = context.resolveImportRecord(records[0]!);
      const equalsResolution = context.resolveImportRecord(records[1]!);

      expect(records.map((record) => record.kind)).toEqual([
        'static',
        'import-equals',
      ]);
      expect(staticResolution.target?.resolvedFileName).toBe(
        normalizeAbsolutePath(
          path.join(rootDir, 'node_modules/dual/import.d.mts'),
        ),
      );
      expect(equalsResolution.target?.resolvedFileName).toBe(
        normalizeAbsolutePath(
          path.join(rootDir, 'node_modules/dual/require.d.cts'),
        ),
      );
      expect(staticResolution.resolutionMode).not.toBe(
        equalsResolution.resolutionMode,
      );
      expect(staticResolution.identity).not.toBe(equalsResolution.identity);
    } finally {
      context.dispose();
    }
  });

  it('uses path, type-reference, and configured-types channels without module reinterpretation', async () => {
    const rootDir = await createFixture({
      'node_modules/happy-dom/index.d.ts':
        'export declare const environment: true;\n',
      'node_modules/happy-dom/package.json': JSON.stringify({
        name: 'happy-dom',
        types: './index.d.ts',
        version: '1.0.0',
      }),
      'src/env.d.ts': 'declare const fromPath: true;\n',
      'src/index.ts': [
        ['// @vitest', '-environment happy-dom'].join(''),
        '/// <reference path="./env.d.ts" />',
        '/// <reference types="foo" />',
        'export {};',
        '',
      ].join('\n'),
      'tsconfig.json': '{}\n',
      'types/configured/index.d.ts': 'declare const configured: true;\n',
      'types/foo/index.d.ts': 'declare const foo: true;\n',
    });
    const moduleSpecifiers: string[] = [];
    const typeSpecifiers: string[] = [];
    const instrumentedTypeScript = {
      ...ts,
      resolveModuleName(...args: Parameters<typeof ts.resolveModuleName>) {
        moduleSpecifiers.push(args[0]);
        return ts.resolveModuleName(...args);
      },
      resolveTypeReferenceDirective(
        ...args: Parameters<typeof ts.resolveTypeReferenceDirective>
      ) {
        typeSpecifiers.push(args[0]);
        return ts.resolveTypeReferenceDirective(...args);
      },
    } as typeof ts;
    const sourceFile = path.join(rootDir, 'src/index.ts');
    const context = createContext({
      fileNames: [sourceFile],
      options: {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        typeRoots: [path.join(rootDir, 'types')],
        types: ['configured'],
      },
      rootDir,
      tsModule: instrumentedTypeScript,
    });

    try {
      const environmentRecord = findRecord(
        context,
        sourceFile,
        'environment-pragma',
      );
      const pathRecord = findRecord(context, sourceFile, 'triple-slash-path');
      const typesRecord = findRecord(context, sourceFile, 'triple-slash-types');
      const environmentResolution =
        context.resolveImportRecord(environmentRecord);
      const pathResolution = context.resolveImportRecord(pathRecord);
      const typesResolution = context.resolveImportRecord(typesRecord);

      expect(environmentResolution).toMatchObject({
        channel: 'environment-pragma',
        target: null,
      });
      expect(pathResolution.channel).toBe('triple-slash-path');
      expect(pathResolution.target?.resolvedFileName).toBe(
        normalizeAbsolutePath(path.join(rootDir, 'src/env.d.ts')),
      );
      expect(typesResolution.channel).toBe('triple-slash-types');
      expect(typesResolution.target?.resolvedFileName).toBe(
        normalizeAbsolutePath(path.join(rootDir, 'types/foo/index.d.ts')),
      );
      expect(
        context.program.getSourceFile(pathResolution.target!.resolvedFileName),
      ).toBeDefined();
      expect(
        context.program.getSourceFile(typesResolution.target!.resolvedFileName),
      ).toBeDefined();
      expect(
        context.program.getSourceFile(
          path.join(rootDir, 'types/configured/index.d.ts'),
        ),
      ).toBeDefined();
      expect(moduleSpecifiers).toEqual([]);
      expect(typeSpecifiers).toEqual(
        expect.arrayContaining(['configured', 'foo']),
      );
    } finally {
      context.dispose();
    }
  });

  it('resolves jsxImportSource through the synthetic JSX runtime occurrence', async () => {
    const rootDir = await createFixture({
      'node_modules/custom/jsx-runtime.d.ts': [
        'export namespace JSX {',
        '  interface IntrinsicElements { div: {}; }',
        '}',
        'export declare function jsx(): unknown;',
        '',
      ].join('\n'),
      'node_modules/custom/package.json': JSON.stringify({
        exports: { './jsx-runtime': './jsx-runtime.d.ts' },
        name: 'custom',
        version: '1.0.0',
      }),
      'src/index.tsx': [
        '/** @jsxImportSource custom */',
        'export const value = <div />;',
        '',
      ].join('\n'),
      'tsconfig.json': '{}\n',
    });
    const sourceFile = path.join(rootDir, 'src/index.tsx');
    const context = createContext({
      fileNames: [sourceFile],
      options: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      },
      rootDir,
    });

    try {
      const record = findRecord(context, sourceFile, 'jsx-import-source');
      const resolution = context.resolveImportRecord(record);
      expect(resolution.channel).toBe('jsx-runtime');
      expect(resolution.target?.resolvedFileName).toBe(
        normalizeAbsolutePath(
          path.join(rootDir, 'node_modules/custom/jsx-runtime.d.ts'),
        ),
      );
    } finally {
      context.dispose();
    }
  });

  it('admits a TypeScript library replacement through the library channel', async () => {
    const rootDir = await createFixture({
      'node_modules/@typescript/lib-dom/index.d.ts':
        'interface CustomDocument { replacement: true; }\n',
      'node_modules/@typescript/lib-dom/package.json': JSON.stringify({
        name: '@typescript/lib-dom',
        types: './index.d.ts',
        version: '1.0.0',
      }),
      'src/index.ts': 'export {};\n',
      'tsconfig.json': '{}\n',
    });
    const sourceFile = path.join(rootDir, 'src/index.ts');
    const replacement = normalizeAbsolutePath(
      path.join(rootDir, 'node_modules/@typescript/lib-dom/index.d.ts'),
    );
    const context = createContext({
      fileNames: [sourceFile],
      options: {
        lib: ['lib.dom.d.ts'],
        libReplacement: true,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      },
      rootDir,
    });

    try {
      expect(context.program.getSourceFile(replacement)).toBeDefined();
    } finally {
      context.dispose();
    }
  });
});
