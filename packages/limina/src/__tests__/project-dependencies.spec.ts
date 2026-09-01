import type { ResolvedCheckerModuleName } from '#checkers';
import {
  createImportAnalysisContext,
  type ImportAnalysisContext,
  type ImportRecord,
} from '#core/import-analysis/runner';
import {
  collectProjectDependencies,
  projectDependencyCreatesSourceEdge,
  type ProjectDependencyPreparation,
  type ProjectSemanticContext,
} from '#core/project-dependencies/runner';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreparedDependencyFact } from '../core/framework-semantic/contracts';
import { cloneProjectDependencyPreparation } from '../core/project-dependencies/cache';
import { createWorkspaceSourceBoundary } from '../core/typescript-semantic';
import { createFixturePathResolver, toPortablePath } from './helpers/path';

const temporaryRoots: string[] = [];

function createRecord(filePath: string, specifier: string): ImportRecord {
  return {
    domain: filePath.endsWith('.vue') ? 'vue-script' : 'typescript',
    filePath,
    kind: 'static',
    line: 1,
    locator: { occurrence: 0, sourceEnd: 14, sourceStart: 7 },
    specifier,
  };
}

function createSemanticContext(options: {
  family: ProjectSemanticContext['semanticAuthority']['family'];
  fileName: string;
  rootDir: string;
}): ProjectSemanticContext {
  const fixturePath = createFixturePathResolver(options.rootDir);
  const fileName = createFixturePathResolver(path.dirname(options.fileName))(
    path.basename(options.fileName),
  );
  const rootDir = fixturePath();
  const context: ProjectSemanticContext = {
    compilerOptions: {
      module: 99,
      moduleResolution: 100,
      target: 99,
    },
    configPath: fixturePath('tsconfig.json'),
    extensions: options.family === 'vue' ? ['.vue'] : [],
    fileNames: [fileName],
    generation: 1,
    packageRootByFileName: new Map([[fileName, rootDir]]),
    packageRootDir: rootDir,
    references: [],
    resolverConfigPath: fixturePath('tsconfig.json'),
    semanticAuthority: {
      family: options.family,
      kind: 'locked',
      source: 'explicit',
    },
    workspaceSourceBoundary: createWorkspaceSourceBoundary([fileName]),
  };
  if (options.family === 'vue') {
    context.vueSemanticIdentity = {
      profilesByFileName: new Map([[fileName, 'vue-sfc']]),
    } as unknown as ProjectSemanticContext['vueSemanticIdentity'];
  }
  return context;
}

function createTarget(
  resolvedFileName: string,
  resolvedBy: ResolvedCheckerModuleName['resolvedBy'] = 'checker-source',
): ResolvedCheckerModuleName {
  return {
    isExternalLibraryImport: false,
    resolvedBy,
    resolvedFileName,
  };
}

function createFact(options: {
  record: ImportRecord;
  semanticSpecifier?: string;
  target?: ResolvedCheckerModuleName | null;
  typeEvidence?: PreparedDependencyFact['typeEvidence'];
}): PreparedDependencyFact {
  const target = options.target ?? null;
  const typeEvidence =
    options.typeEvidence ??
    (target === null
      ? { kind: 'missing' as const }
      : {
          filePath: target.resolvedFileName,
          kind: 'checker-source' as const,
        });
  const semanticSpecifier = options.semanticSpecifier ?? './target.js';
  return {
    framework: 'vue',
    importRecord: { ...options.record, specifier: semanticSpecifier },
    provenance: 'strict-source-map',
    resolutionMode: 'import',
    semanticSpecifier,
    target,
    typeEvidence,
  };
}

function withPreparedFact(fact: PreparedDependencyFact): {
  context: ImportAnalysisContext;
  resolveCheckerImportEvidence: ReturnType<typeof vi.fn>;
  resolveOxcImport: ReturnType<typeof vi.fn>;
} {
  const base = createImportAnalysisContext();
  const resolveCheckerImportEvidence = vi.fn(() => {
    throw new Error('framework prepared facts must not be re-resolved');
  });
  const resolveOxcImport = vi.fn(() => {
    throw new Error('locked framework facts must not use Oxc rescue');
  });
  return {
    context: {
      ...base,
      prepareCheckerSemanticDependencies: vi.fn(() => ({
        directSourceRecords: [],
        facts: [fact],
        kind: 'supported' as const,
        unmapped: [],
      })),
      resolveCheckerImportEvidence,
      resolveOxcImport,
    },
    resolveCheckerImportEvidence,
    resolveOxcImport,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((rootDir) => rm(rootDir, { force: true, recursive: true })),
  );
});

describe('project dependency authority', () => {
  it('uses TypeScript AST plus checker resolution for direct-source dependencies', async () => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), 'limina-project-deps-'),
    );
    temporaryRoots.push(temporaryRoot);
    const fixturePath = createFixturePathResolver(temporaryRoot);
    const rootDir = fixturePath();
    const sourceFile = fixturePath('index.ts');
    const targetFile = fixturePath('target.ts');
    await writeFile(sourceFile, "import './target';\n", 'utf8');
    await writeFile(targetFile, 'export const target = true;\n', 'utf8');
    const base = createImportAnalysisContext();
    const resolveOxcImport = vi.fn(base.resolveOxcImport);

    const collection = collectProjectDependencies({
      context: createSemanticContext({
        family: 'typescript',
        fileName: sourceFile,
        rootDir,
      }),
      importAnalysis: { ...base, resolveOxcImport },
    });

    expect(collection.failures).toEqual([]);
    expect(collection.dependencies).toMatchObject([
      {
        provenance: 'direct-source',
        resolvedFilePath: targetFile,
        semanticSpecifier: './target',
        targetKind: 'source',
        typeEvidence: { kind: 'checker-source' },
      },
    ]);
    expect(resolveOxcImport).not.toHaveBeenCalled();
  });

  it('uses the admitted triple-slash path target without module reinterpretation', async () => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), 'limina-project-deps-triple-'),
    );
    temporaryRoots.push(temporaryRoot);
    const fixturePath = createFixturePathResolver(temporaryRoot);
    const rootDir = fixturePath();
    const sourceFile = fixturePath('index.ts');
    const targetFile = fixturePath('env.d.ts');
    await writeFile(
      sourceFile,
      '/// <reference path="./env.d.ts" />\nexport {};\n',
      'utf8',
    );
    await writeFile(targetFile, 'declare const environment: true;\n', 'utf8');
    const base = createImportAnalysisContext();
    const channels: string[] = [];
    const importAnalysis = {
      ...base,
      resolveCheckerImportEvidence: vi.fn(
        (
          ...args: Parameters<
            ImportAnalysisContext['resolveCheckerImportEvidence']
          >
        ) => {
          const record = args[0];
          const context = args[3];
          const semanticContext = Array.isArray(context)
            ? undefined
            : context?.typeScriptSemanticContext;
          channels.push(semanticContext!.resolveImportRecord(record).channel);
          return base.resolveCheckerImportEvidence(...args);
        },
      ),
    } satisfies ImportAnalysisContext;

    const collection = collectProjectDependencies({
      context: createSemanticContext({
        family: 'typescript',
        fileName: sourceFile,
        rootDir,
      }),
      importAnalysis,
    });

    expect(collection.failures).toEqual([]);
    expect(collection.dependencies).toMatchObject([
      {
        importRecord: { kind: 'triple-slash-path' },
        provenance: 'direct-source',
        resolutionMode: 'default',
        resolvedFilePath: targetFile,
        targetKind: 'declaration',
      },
    ]);
    expect(channels).toEqual(['triple-slash-path']);
  });

  it('uses occurrence-specific NodeNext modes in locked dependency collection', async () => {
    const temporaryRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-project-deps-nodenext-')),
    );
    temporaryRoots.push(temporaryRoot);
    const fixturePath = createFixturePathResolver(temporaryRoot);
    const rootDir = fixturePath();
    const sourceFile = fixturePath('index.mts');
    await mkdir(fixturePath('node_modules/dual'), { recursive: true });
    await writeFile(
      sourceFile,
      [
        "import imported from 'dual';",
        "import required = require('dual');",
        'void imported;',
        'void required;',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      fixturePath('node_modules/dual/package.json'),
      JSON.stringify({
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
      'utf8',
    );
    await writeFile(
      fixturePath('node_modules/dual/import.d.mts'),
      'declare const value: "import"; export default value;\n',
      'utf8',
    );
    await writeFile(
      fixturePath('node_modules/dual/import.js'),
      'export default "import";\n',
      'utf8',
    );
    await writeFile(
      fixturePath('node_modules/dual/require.d.cts'),
      'declare const value: "require"; export = value;\n',
      'utf8',
    );
    await writeFile(
      fixturePath('node_modules/dual/require.cjs'),
      'module.exports = "require";\n',
      'utf8',
    );
    const context = createSemanticContext({
      family: 'typescript',
      fileName: sourceFile,
      rootDir,
    });
    context.compilerOptions = {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2023,
    };

    const collection = collectProjectDependencies({
      context,
      importAnalysis: createImportAnalysisContext(),
    });

    expect(collection.failures).toEqual([]);
    expect(collection.dependencies).toMatchObject([
      {
        importRecord: { kind: 'static', specifier: 'dual' },
        resolutionMode: 'import',
        resolvedFilePath: toPortablePath(
          fixturePath('node_modules/dual/import.d.mts'),
        ),
      },
      {
        importRecord: { kind: 'import-equals', specifier: 'dual' },
        resolutionMode: 'require',
        resolvedFilePath: toPortablePath(
          fixturePath('node_modules/dual/require.d.cts'),
        ),
      },
    ]);
  });

  it('consumes a prepared source target without framework re-resolution', () => {
    const fixturePath = createFixturePathResolver('/virtual/mapped-vue');
    const rootDir = fixturePath();
    const sourceFile = fixturePath('App.vue');
    const targetFile = fixturePath('target.ts');
    const record = createRecord(sourceFile, './target.ts');
    const fact = createFact({ record, target: createTarget(targetFile) });
    const analysis = withPreparedFact(fact);
    const resolveWorkspaceTypeScriptExport = vi.fn(() => targetFile);

    const collection = collectProjectDependencies({
      context: createSemanticContext({
        family: 'vue',
        fileName: sourceFile,
        rootDir,
      }),
      importAnalysis: analysis.context,
      resolveWorkspaceTypeScriptExport,
    });

    expect(collection.failures).toEqual([]);
    expect(collection.dependencies).toMatchObject([
      {
        framework: 'vue',
        importRecord: { filePath: sourceFile, specifier: './target.js' },
        provenance: 'strict-source-map',
        semanticSpecifier: './target.js',
        resolvedFilePath: targetFile,
        typeEvidence: { filePath: targetFile, kind: 'checker-source' },
      },
    ]);
    expect(analysis.resolveCheckerImportEvidence).not.toHaveBeenCalled();
    expect(analysis.resolveOxcImport).not.toHaveBeenCalled();
    expect(resolveWorkspaceTypeScriptExport).not.toHaveBeenCalled();
  });

  it('classifies target-null ambient evidence as a typed non-source observation', () => {
    const rootDir = '/virtual/ambient-vue';
    const sourceFile = path.join(rootDir, 'App.vue');
    const fact = createFact({
      record: createRecord(sourceFile, './theme.css'),
      semanticSpecifier: './theme.css',
      target: null,
      typeEvidence: {
        declarationFilePaths: [path.join(rootDir, 'env.d.ts')],
        kind: 'ambient',
        modulePattern: '*.css',
      },
    });
    const analysis = withPreparedFact(fact);

    const collection = collectProjectDependencies({
      context: createSemanticContext({
        family: 'vue',
        fileName: sourceFile,
        rootDir,
      }),
      importAnalysis: analysis.context,
    });

    expect(collection.dependencies).toEqual([]);
    expect(collection.failures).toEqual([]);
    expect(collection.observations).toMatchObject([
      {
        importRecord: { specifier: './theme.css' },
        kind: 'resource',
        typeEvidence: { kind: 'ambient', modulePattern: '*.css' },
      },
    ]);
    expect(analysis.resolveCheckerImportEvidence).not.toHaveBeenCalled();
    expect(analysis.resolveOxcImport).not.toHaveBeenCalled();
  });

  it('keeps an existing resource missing without checker type evidence', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-resource-miss-'));
    temporaryRoots.push(rootDir);
    const sourceFile = path.join(rootDir, 'App.vue');
    await mkdir(rootDir, { recursive: true });
    await writeFile(path.join(rootDir, 'theme.css'), '.app {}\n', 'utf8');
    const fact = createFact({
      record: createRecord(sourceFile, './theme.css'),
      semanticSpecifier: './theme.css',
      target: null,
      typeEvidence: { kind: 'missing' },
    });
    const analysis = withPreparedFact(fact);

    const collection = collectProjectDependencies({
      context: createSemanticContext({
        family: 'vue',
        fileName: sourceFile,
        rootDir,
      }),
      importAnalysis: analysis.context,
    });

    expect(collection.dependencies).toEqual([]);
    expect(collection.failures).toEqual([]);
    expect(collection.observations).toMatchObject([
      { importRecord: { specifier: './theme.css' }, kind: 'missing' },
    ]);
    expect(analysis.resolveCheckerImportEvidence).not.toHaveBeenCalled();
    expect(analysis.resolveOxcImport).not.toHaveBeenCalled();
  });

  it('fails closed when prepared target and TypeEvidence paths disagree', () => {
    const rootDir = '/virtual/mismatch-vue';
    const sourceFile = path.join(rootDir, 'App.vue');
    const fact = createFact({
      record: createRecord(sourceFile, './target'),
      target: createTarget(path.join(rootDir, 'target.ts')),
      typeEvidence: {
        filePath: path.join(rootDir, 'other.ts'),
        kind: 'checker-source',
      },
    });
    const analysis = withPreparedFact(fact);

    const collection = collectProjectDependencies({
      context: createSemanticContext({
        family: 'vue',
        fileName: sourceFile,
        rootDir,
      }),
      importAnalysis: analysis.context,
    });

    expect(collection.dependencies).toEqual([]);
    expect(collection.failures).toMatchObject([
      { framework: 'vue', stage: 'module-resolution' },
    ]);
    expect(analysis.resolveCheckerImportEvidence).not.toHaveBeenCalled();
    expect(analysis.resolveOxcImport).not.toHaveBeenCalled();
  });

  it.each([
    {
      evidence: {
        filePath: '/virtual/mismatch-kind-vue/target.ts',
        kind: 'concrete-declaration' as const,
      },
      name: 'source target with declaration evidence',
      target: createTarget('/virtual/mismatch-kind-vue/target.ts'),
    },
    {
      evidence: {
        filePath: '/virtual/mismatch-kind-vue/target.d.ts',
        kind: 'checker-source' as const,
      },
      name: 'declaration target with source evidence',
      target: createTarget('/virtual/mismatch-kind-vue/target.d.ts'),
    },
    {
      evidence: {
        filePath: '/virtual/mismatch-kind-vue/target.d.mts',
        kind: 'checker-source' as const,
      },
      name: '.d.mts target with source evidence',
      target: createTarget(
        '/virtual/mismatch-kind-vue/target.d.mts',
        'typescript',
      ),
    },
  ])('fails closed for $name at the same path', ({ evidence, target }) => {
    const rootDir = '/virtual/mismatch-kind-vue';
    const sourceFile = `${rootDir}/App.vue`;
    const fact = createFact({
      record: createRecord(sourceFile, './target'),
      target,
      typeEvidence: evidence,
    });
    const analysis = withPreparedFact(fact);

    const collection = collectProjectDependencies({
      context: createSemanticContext({
        family: 'vue',
        fileName: sourceFile,
        rootDir,
      }),
      importAnalysis: analysis.context,
    });

    expect(collection.dependencies).toEqual([]);
    expect(collection.observations).toEqual([]);
    expect(collection.failures).toMatchObject([
      { framework: 'vue', stage: 'module-resolution' },
    ]);
    expect(analysis.resolveCheckerImportEvidence).not.toHaveBeenCalled();
    expect(analysis.resolveOxcImport).not.toHaveBeenCalled();
  });

  it('deep-clones prepared targets, ambient declarations, and managed sources', () => {
    const fact = createFact({
      record: createRecord('/workspace/App.vue', './types'),
      target: createTarget('/workspace/types.d.ts', 'typescript'),
      typeEvidence: {
        filePath: '/workspace/types.d.ts',
        kind: 'concrete-declaration',
        managedSource: {
          checkerNames: ['vue-tsc', 'tsc'],
          declarationFilePath: '/workspace/types.d.ts',
          mappedSourceFilePath: '/workspace/types.ts',
          reason: 'owned-source',
          sourceConfigPath: '/workspace/tsconfig.json',
        },
      },
    });
    const preparation: ProjectDependencyPreparation = {
      directSourceRecords: [],
      facts: [fact],
      failures: [],
      observations: [],
      ready: true,
    };

    const cloned = cloneProjectDependencyPreparation(preparation);

    expect(cloned).toEqual(preparation);
    expect(cloned.facts[0]).not.toBe(fact);
    expect(cloned.facts[0]!.target).not.toBe(fact.target);
    expect(cloned.facts[0]!.typeEvidence).not.toBe(fact.typeEvidence);
    expect(
      cloned.facts[0]!.typeEvidence.kind === 'concrete-declaration'
        ? cloned.facts[0]!.typeEvidence.managedSource?.checkerNames
        : null,
    ).not.toBe(
      fact.typeEvidence.kind === 'concrete-declaration'
        ? fact.typeEvidence.managedSource?.checkerNames
        : null,
    );
  });

  it('never admits an unmapped generated dependency as a source edge', () => {
    expect(
      projectDependencyCreatesSourceEdge({
        generatedFilePath: '/workspace/App.svelte.tsx',
        kind: 'unmapped-generated',
        semanticSpecifier: '/workspace/owned.ts',
      }),
    ).toBe(false);
  });
});
