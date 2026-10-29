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
import {
  createBoundedTypeScriptSemanticContext,
  createWorkspaceSourceBoundary,
} from '../core/typescript-semantic';
import type { TypeScriptSemanticContext } from '../core/typescript-semantic/contracts';
import { readFixtureSourceCoverage } from './helpers/native-coverage';

const temporaryRoots: string[] = [];

async function createFixture(files: Record<string, string>): Promise<string> {
  const rootDirectoryTemporaryPath = await mkdtemp(
    path.join(tmpdir(), 'limina-ts-semantic-'),
  );
  const rootDirectory = await realpath(rootDirectoryTemporaryPath);
  temporaryRoots.push(rootDirectory);
  for (const [relativePath, sourceText] of Object.entries(files)) {
    const filePath = path.join(rootDirectory, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, sourceText, 'utf8');
  }
  return rootDirectory;
}

function createContext(options: {
  unavailableCoverage?: boolean;
  coverageConfigs?: string[];
  fileNames: string[];
  options: ts.CompilerOptions;
  projectReferences?: readonly ts.ProjectReference[];
  rootDir: string;
  workspaceSourceFileNames?: string[];
}): TypeScriptSemanticContext {
  const configs = options.coverageConfigs ?? [
    path.join(options.rootDir, 'tsconfig.json'),
  ];
  const coverage = options.unavailableCoverage
    ? undefined
    : readFixtureSourceCoverage(configs.map(normalizeAbsolutePath));
  return createBoundedTypeScriptSemanticContext({
    admissionMode: 'coverage-bounded',
    configPath: path.join(options.rootDir, 'tsconfig.json'),
    fileNames: options.fileNames,
    options: {
      configFilePath: path.join(options.rootDir, 'tsconfig.json'),
      ...options.options,
    },
    projectReferences: options.projectReferences,
    workspaceSourceBoundary: createWorkspaceSourceBoundary(
      options.workspaceSourceFileNames ?? options.fileNames,
      undefined,
      coverage,
    ),
  });
}

function findRecord(
  context: TypeScriptSemanticContext,
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
      .map((rootDirectory) =>
        rm(rootDirectory, { force: true, recursive: true }),
      ),
  );
});

describe('bounded TypeScript semantic context', () => {
  it('preserves an explicit JSON project root admitted by checker extension authority', async () => {
    const rootDirectory = await createFixture({
      'src/data.json': '{"value":true}\n',
      'tsconfig.json': '{}\n',
    });
    const jsonFile = normalizeAbsolutePath(
      path.join(rootDirectory, 'src/data.json'),
    );
    const context = createContext({
      fileNames: [jsonFile],
      options: {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        resolveJsonModule: true,
      },
      rootDir: rootDirectory,
    });

    try {
      expect(context.program.getRootFileNames()).toContain(jsonFile);
      expect(context.program.getSourceFile(jsonFile)).toBeDefined();
    } finally {
      context.dispose();
    }
  });

  it('does not incidentally admit a resolved non-root JSON module', async () => {
    const rootDirectory = await createFixture({
      'src/data.json': '{"value":true}\n',
      'src/index.ts': "import data from './data.json';\nvoid data;\n",
      'tsconfig.json': '{}\n',
    });
    const sourceFile = path.join(rootDirectory, 'src/index.ts');
    const jsonFile = normalizeAbsolutePath(
      path.join(rootDirectory, 'src/data.json'),
    );
    const context = createContext({
      fileNames: [sourceFile],
      options: {
        allowSyntheticDefaultImports: true,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        resolveJsonModule: true,
      },
      rootDir: rootDirectory,
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
    const rootDirectory = await createFixture({
      'src/index.ts': "import './internal';\n",
      'src/internal.ts': 'export const internal = true;\n',
      'tsconfig.json': '{}\n',
    });
    const sourceFile = path.join(rootDirectory, 'src/index.ts');
    const internalFile = normalizeAbsolutePath(
      path.join(rootDirectory, 'src/internal.ts'),
    );
    const context = createContext({
      fileNames: [sourceFile],
      options: {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      },
      rootDir: rootDirectory,
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

  it('stops external declarations despite complete Coverage and retains their incoming target', async () => {
    const rootDirectory = await createFixture({
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
      'tsconfig.coverage.json': JSON.stringify({
        files: [
          'node_modules/pkg/index.d.ts',
          'node_modules/pkg/internal.d.ts',
        ],
      }),
    });
    const sourceFile = path.join(rootDirectory, 'src/index.ts');
    const internalFile = normalizeAbsolutePath(
      path.join(rootDirectory, 'node_modules/pkg/internal.d.ts'),
    );
    const context = createContext({
      fileNames: [sourceFile],
      options: {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      },
      rootDir: rootDirectory,
      coverageConfigs: [
        path.join(rootDirectory, 'tsconfig.json'),
        path.join(rootDirectory, 'tsconfig.coverage.json'),
      ],
    });

    try {
      expect(context.program.getSourceFile(internalFile)).toBeUndefined();
      expect(
        context.resolveImportRecord(findRecord(context, sourceFile, 'static'))
          .target?.resolvedFileName,
      ).toBe(
        normalizeAbsolutePath(
          path.join(rootDirectory, 'node_modules/pkg/index.d.ts'),
        ),
      );
    } finally {
      context.dispose();
    }
  });

  it('retains root dependency facts while an unavailable Coverage index stops the closure', async () => {
    const rootDirectory = await createFixture({
      'node_modules/pkg/index.d.ts': "export * from './internal';\n",
      'node_modules/pkg/internal.d.ts':
        'export declare const internal: true;\n',
      'node_modules/pkg/package.json': JSON.stringify({
        name: 'pkg',
        types: './index.d.ts',
        version: '1.0.0',
      }),
      'src/env.d.ts': 'declare const fromPath: true;\n',
      'src/index.ts': [
        '/// <reference path="./env.d.ts" />',
        "import { internal } from 'pkg';",
        'void internal;',
        '',
      ].join('\n'),
      'tsconfig.json': '{}\n',
    });
    const sourceFile = path.join(rootDirectory, 'src/index.ts');
    const packageEntry = normalizeAbsolutePath(
      path.join(rootDirectory, 'node_modules/pkg/index.d.ts'),
    );
    const packageInternal = normalizeAbsolutePath(
      path.join(rootDirectory, 'node_modules/pkg/internal.d.ts'),
    );
    const referencedFile = normalizeAbsolutePath(
      path.join(rootDirectory, 'src/env.d.ts'),
    );
    const context = createContext({
      unavailableCoverage: true,
      fileNames: [sourceFile],
      options: {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      },
      rootDir: rootDirectory,
    });

    try {
      const moduleRecord = findRecord(context, sourceFile, 'static');
      const pathRecord = findRecord(context, sourceFile, 'triple-slash-path');

      expect(
        context.resolveImportRecord(moduleRecord).target?.resolvedFileName,
      ).toBe(packageEntry);
      expect(
        context.resolveImportRecord(pathRecord).target?.resolvedFileName,
      ).toBe(referencedFile);
      expect(context.program.getSourceFile(sourceFile)).toBeDefined();
      expect(context.program.getSourceFile(packageEntry)).toBeUndefined();
      expect(context.program.getSourceFile(packageInternal)).toBeUndefined();
      expect(context.program.getSourceFile(referencedFile)).toBeUndefined();
      expect(
        context.program
          .getSourceFiles()
          .some((sourceFile) =>
            path.basename(sourceFile.fileName).startsWith('lib.'),
          ),
      ).toBe(false);
    } finally {
      context.dispose();
    }
  });

  it.each([false, true])(
    'stops explicitly covered external declarations across preserveSymlinks=%s',
    async (preserveSymlinks) => {
      const rootDirectory = await createFixture({
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
        path.join(rootDirectory, 'external/pkg'),
        path.join(rootDirectory, 'node_modules/pkg'),
        'dir',
      );
      const sourceFile = path.join(rootDirectory, 'src/index.ts');
      const context = createContext({
        fileNames: [sourceFile],
        options: {
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          preserveSymlinks,
        },
        rootDir: rootDirectory,
      });

      try {
        const record = findRecord(context, sourceFile, 'static');
        const target = context.resolveImportRecord(record).target;
        expect(target?.isExternalLibraryImport).toBe(true);
        expect(
          context.program.getSourceFile(target!.resolvedFileName),
        ).toBeUndefined();
      } finally {
        context.dispose();
      }
    },
  );

  it.each([false, true])(
    'blocks a governed workspace source reached through node_modules with preserveSymlinks=%s',
    async (preserveSymlinks) => {
      const rootDirectory = await createFixture({
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
        path.join(rootDirectory, 'B'),
        path.join(rootDirectory, 'A/node_modules/@workspace/b'),
        'dir',
      );
      const sourceFile = path.join(rootDirectory, 'A/src/index.ts');
      const foreignSource = normalizeAbsolutePath(
        path.join(rootDirectory, 'B/src/index.ts'),
      );
      const foreignEnvironment = normalizeAbsolutePath(
        path.join(rootDirectory, 'B/src/env.d.ts'),
      );
      const context = createContext({
        fileNames: [sourceFile],
        options: {
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          preserveSymlinks,
        },
        rootDir: path.join(rootDirectory, 'A'),
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

  it('preserves raw project references and retains declaration outputs without loading implementation', async () => {
    const rootDirectory = await createFixture({
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
    const sourceFile = path.join(rootDirectory, 'A/src/index.ts');
    const referencedFile = normalizeAbsolutePath(
      path.join(rootDirectory, 'B/src/index.ts'),
    );
    const referencedDeclaration = normalizeAbsolutePath(
      path.join(rootDirectory, 'B/src/index.d.ts'),
    );
    const compilerOptions = {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    };
    const parsed = parseConfig(path.join(rootDirectory, 'A/tsconfig.json'));
    const withoutReference = createContext({
      fileNames: [sourceFile],
      options: compilerOptions,
      rootDir: path.join(rootDirectory, 'A'),
    });
    const withReference = createContext({
      fileNames: [sourceFile],
      options: compilerOptions,
      projectReferences: parsed.projectReferences,
      rootDir: path.join(rootDirectory, 'A'),
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
    const rootDirectory = await createFixture({
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
    const sourceFile = path.join(rootDirectory, 'src/index.mts');
    const context = createContext({
      fileNames: [sourceFile],
      options: {
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        target: ts.ScriptTarget.ES2023,
      },
      rootDir: rootDirectory,
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
          path.join(rootDirectory, 'node_modules/dual/import.d.mts'),
        ),
      );
      expect(equalsResolution.target?.resolvedFileName).toBe(
        normalizeAbsolutePath(
          path.join(rootDirectory, 'node_modules/dual/require.d.cts'),
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
    const rootDirectory = await createFixture({
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
    const sourceFile = path.join(rootDirectory, 'src/index.ts');
    const context = createContext({
      fileNames: [sourceFile],
      options: {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        typeRoots: [path.join(rootDirectory, 'types')],
        types: ['configured'],
      },
      rootDir: rootDirectory,
    });

    try {
      const pathRecord = findRecord(context, sourceFile, 'triple-slash-path');
      const typesRecord = findRecord(context, sourceFile, 'triple-slash-types');
      const pathResolution = context.resolveImportRecord(pathRecord);
      const typesResolution = context.resolveImportRecord(typesRecord);

      expect(
        context
          .getImportRecords(sourceFile)
          .some((record) => record.specifier === 'happy-dom'),
      ).toBe(false);
      expect(pathResolution.channel).toBe('triple-slash-path');
      expect(pathResolution.target?.resolvedFileName).toBe(
        normalizeAbsolutePath(path.join(rootDirectory, 'src/env.d.ts')),
      );
      expect(typesResolution.channel).toBe('triple-slash-types');
      expect(typesResolution.target?.resolvedFileName).toBe(
        normalizeAbsolutePath(path.join(rootDirectory, 'types/foo/index.d.ts')),
      );
      expect(
        context.program.getSourceFile(pathResolution.target!.resolvedFileName),
      ).toBeUndefined();
      expect(
        context.program.getSourceFile(typesResolution.target!.resolvedFileName),
      ).toBeUndefined();
      expect(
        context.program.getSourceFile(
          path.join(rootDirectory, 'types/configured/index.d.ts'),
        ),
      ).toBeUndefined();
      expect(
        context.nativeEvidence?.requests.filter(
          (request) => request.channel === 'module',
        ),
      ).toEqual([]);
      expect(
        context.nativeEvidence?.requests
          .filter((request) => request.channel === 'type-directive')
          .map((request) => request.specifier),
      ).toEqual(expect.arrayContaining(['configured', 'foo']));
    } finally {
      context.dispose();
    }
  });

  it('resolves jsxImportSource through the synthetic JSX runtime occurrence', async () => {
    const rootDirectory = await createFixture({
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
    const sourceFile = path.join(rootDirectory, 'src/index.tsx');
    const context = createContext({
      fileNames: [sourceFile],
      options: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      },
      rootDir: rootDirectory,
    });

    try {
      const record = findRecord(context, sourceFile, 'jsx-import-source');
      const resolution = context.resolveImportRecord(record);
      expect(resolution.channel).toBe('jsx-runtime');
      expect(resolution.target?.resolvedFileName).toBe(
        normalizeAbsolutePath(
          path.join(rootDirectory, 'node_modules/custom/jsx-runtime.d.ts'),
        ),
      );
    } finally {
      context.dispose();
    }
  });

  it('retains a compiler-requested unmanaged TypeScript library replacement', async () => {
    const rootDirectory = await createFixture({
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
    const sourceFile = path.join(rootDirectory, 'src/index.ts');
    const replacement = normalizeAbsolutePath(
      path.join(rootDirectory, 'node_modules/@typescript/lib-dom/index.d.ts'),
    );
    const context = createContext({
      fileNames: [sourceFile],
      options: {
        lib: ['lib.dom.d.ts'],
        libReplacement: true,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      },
      rootDir: rootDirectory,
    });

    try {
      expect(context.program.getSourceFile(replacement)?.fileName).toBe(
        replacement,
      );
      expect(context.nativeEvidence?.resolutions).toContainEqual(
        expect.objectContaining({
          target: expect.objectContaining({ lexicalPath: replacement }),
        }),
      );
    } finally {
      context.dispose();
    }
  });
});
