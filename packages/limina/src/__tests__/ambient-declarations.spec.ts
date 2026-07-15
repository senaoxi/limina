import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type { PackageOwner, WorkspacePackage } from '#core/workspace/actions';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceLookupIndex } from '../core/workspace/lookup';
import {
  createWorkspaceRegionBoundaryIndex,
  type WorkspaceRegionBoundary,
} from '../core/workspace/regions';
import { createAmbientDeclarationIndex } from '../source-check/ambient-declarations';

async function writeText(
  rootDir: string,
  relativePath: string,
  text: string,
): Promise<string> {
  const filePath = path.join(rootDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
  return filePath;
}

function createGraph(
  options: { managed?: string[]; sourceConfigPaths?: string[] } = {},
): GeneratedTsconfigGraphResult {
  return {
    dtsToSource: new Map([
      [
        'typescript',
        new Map(
          (options.managed ?? []).map((filePath) => [
            filePath,
            `${filePath}.source`,
          ]),
        ),
      ],
    ]),
    sourceToBuild: new Map([
      [
        'typescript',
        new Map(
          (options.sourceConfigPaths ?? []).map((configPath) => [
            configPath,
            { kind: 'project', path: `${configPath}.build` },
          ]),
        ),
      ],
    ]),
  } as unknown as GeneratedTsconfigGraphResult;
}

async function createContext(
  options: {
    boundaries?: WorkspaceRegionBoundary[];
    manifest?: WorkspacePackage['manifest'];
  } = {},
) {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-ambient-')),
  );
  const workspacePackage: WorkspacePackage = {
    directory: rootDir,
    manifest: { name: 'root', private: true, ...options.manifest },
    name: 'root',
  };
  const owner: PackageOwner = {
    ...workspacePackage,
    packageJsonPath: path.join(rootDir, 'package.json'),
  };
  const boundaries = options.boundaries ?? [];
  return {
    boundaries,
    cleanup: () => rm(rootDir, { force: true, recursive: true }),
    owner,
    packages: [workspacePackage],
    rootDir,
    workspaceLookup: new WorkspaceLookupIndex({
      importers: [],
      owners: [owner],
      packages: [workspacePackage],
      regionBoundaries: boundaries,
      rootDir,
    }),
  };
}

function createConfig(
  rootDir: string,
  ambient: NonNullable<
    NonNullable<ResolvedLiminaConfig['source']>['declarations']
  >['ambient'],
): ResolvedLiminaConfig {
  return {
    rootDir,
    source: { declarations: { ambient } },
  } as ResolvedLiminaConfig;
}

describe('ambient declaration index', () => {
  it.each([
    ['module.d.ts', "declare module 'foo' {}\n"],
    ['namespace.d.ts', 'declare namespace NodeJS {}\n'],
    ['interface.d.ts', 'interface GlobalInterface {}\n'],
    ['global.d.ts', 'export {}\ndeclare global { interface Window {} }\n'],
    ['index.d.ts', '/// <reference path="./local.d.ts" />\n'],
  ])('accepts the ambient role in %s', async (relativePath, contents) => {
    const context = await createContext();
    try {
      const filePath = await writeText(context.rootDir, relativePath, contents);
      if (relativePath === 'index.d.ts')
        await writeText(context.rootDir, 'local.d.ts', 'interface Local {}\n');
      const result = await createAmbientDeclarationIndex({
        config: createConfig(context.rootDir, [
          { include: [relativePath], reason: 'Shared shim.' },
        ]),
        generatedGraph: createGraph(),
        packages: context.packages,
        regionBoundaries: createWorkspaceRegionBoundaryIndex(
          [],
          context.packages,
        ),
        workspaceLookup: context.workspaceLookup,
      });
      expect(result.issues).toEqual([]);
      expect(result.index.has(filePath)).toBe(true);
      expect(result.index.get(filePath)).toMatchObject({
        allowSharedAcrossOwners: false,
        allowTripleSlashReferences: false,
      });
    } finally {
      await context.cleanup();
    }
  });

  it.each([
    ['interface.d.ts', 'export interface Foo {}\n'],
    ['type.d.ts', 'export type Foo = {}\n'],
    ['reexport.d.ts', "export { Foo } from './foo'\n"],
    [
      'import.d.ts',
      "import type { Foo } from './foo'\nexport interface Bar extends Foo {}\n",
    ],
  ])(
    'rejects ordinary external declaration API %s',
    async (relativePath, contents) => {
      const context = await createContext();
      try {
        await writeText(context.rootDir, relativePath, contents);
        const result = await createAmbientDeclarationIndex({
          config: createConfig(context.rootDir, [
            { include: [relativePath], reason: 'Invalid.' },
          ]),
          generatedGraph: createGraph(),
          packages: context.packages,
          regionBoundaries: createWorkspaceRegionBoundaryIndex(
            [],
            context.packages,
          ),
          workspaceLookup: context.workspaceLookup,
        });
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0]?.code).toBe(
          'LIMINA_SOURCE_AMBIENT_DECLARATION_CONFIG_INVALID',
        );
      } finally {
        await context.cleanup();
      }
    },
  );

  it('rejects unused, non-declaration, overlapping, managed, output, public-entry, and region-crossing rules', async () => {
    const context = await createContext({
      manifest: {
        exports: { '.': { types: './exported.d.ts' } },
        types: 'public.d.ts',
      },
    });
    try {
      const nestedRoot = path.join(context.rootDir, 'nested');
      const boundary: WorkspaceRegionBoundary = {
        kind: 'package-scope',
        rootDir: nestedRoot,
        packageJsonPath: path.join(nestedRoot, 'package.json'),
        excluded: true,
      };
      const workspaceLookup = new WorkspaceLookupIndex({
        importers: [],
        owners: [context.owner],
        packages: context.packages,
        regionBoundaries: [boundary],
        rootDir: context.rootDir,
      });
      const ordinary = await writeText(
        context.rootDir,
        'ordinary.ts',
        'export {}\n',
      );
      const shared = await writeText(
        context.rootDir,
        'shared.d.ts',
        'interface Shared {}\n',
      );
      const managed = await writeText(
        context.rootDir,
        '.limina/managed.d.ts',
        'interface Managed {}\n',
      );
      const publicEntry = await writeText(
        context.rootDir,
        'public.d.ts',
        'interface Public {}\n',
      );
      const exportedEntry = await writeText(
        context.rootDir,
        'exported.d.ts',
        'interface Exported {}\n',
      );
      const tsconfig = await writeText(
        context.rootDir,
        'tsconfig.json',
        JSON.stringify({ liminaOptions: { outputs: { outDir: './dist' } } }),
      );
      await writeText(
        context.rootDir,
        'dist/output.d.ts',
        'interface Output {}\n',
      );
      await writeText(
        context.rootDir,
        'nested/blocked.d.ts',
        'interface Blocked {}\n',
      );
      const result = await createAmbientDeclarationIndex({
        config: createConfig(context.rootDir, [
          { include: ['missing/**/*.d.ts'], reason: 'unused' },
          { include: ['ordinary.ts'], reason: 'wrong extension' },
          { include: ['shared.d.ts'], reason: 'overlap one' },
          { include: ['shared.d.ts'], reason: 'overlap two' },
          { include: ['.limina/**/*.d.ts'], reason: 'managed' },
          { include: ['dist/**/*.d.ts'], reason: 'output' },
          { include: ['public.d.ts'], reason: 'public' },
          { include: ['exported.d.ts'], reason: 'exports types' },
          { include: ['nested/**/*.d.ts'], reason: 'region' },
        ]),
        generatedGraph: createGraph({
          managed: [managed],
          sourceConfigPaths: [tsconfig],
        }),
        packages: context.packages,
        regionBoundaries: createWorkspaceRegionBoundaryIndex(
          [boundary],
          context.packages,
        ),
        workspaceLookup,
      });
      expect(result.issues.length).toBeGreaterThanOrEqual(8);
      expect(result.index.has(ordinary)).toBe(false);
      expect(result.index.has(shared)).toBe(false);
      expect(result.index.has(publicEntry)).toBe(false);
      expect(result.index.has(exportedEntry)).toBe(false);
    } finally {
      await context.cleanup();
    }
  });
});
