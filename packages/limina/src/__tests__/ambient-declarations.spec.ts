import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type { WorkspacePackage } from '#core/workspace/actions';
import { normalizeAbsolutePath } from '#utils/path';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkspaceRegionBoundary } from '../core/workspace/regions';
import type { ValidatedWorkspaceContext } from '../core/workspace/validated-context';
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

function createWorkspaceContext(options: {
  boundaries?: WorkspaceRegionBoundary[];
  configRootDir: string;
  outputRoots?: string[];
  packages: WorkspacePackage[];
  sourceConfigPaths?: string[];
}): ValidatedWorkspaceContext {
  return {
    boundaries: options.boundaries ?? [],
    configRootDir: options.configRootDir,
    descriptorCandidates: [],
    extendedPackageScopes: [],
    outputRoots: options.outputRoots ?? [],
    packageIdentities: options.packages.map((workspacePackage) => ({
      canonicalDirectory: normalizeAbsolutePath(workspacePackage.directory),
      displayDirectory: path.relative(
        options.configRootDir,
        workspacePackage.directory,
      ),
      package: workspacePackage,
    })),
    packages: options.packages,
    rawPackages: options.packages,
    sourceConfigPaths: options.sourceConfigPaths ?? [],
    workspaceRootDir: options.configRootDir,
  };
}

async function createContext(
  options: {
    boundaries?: WorkspaceRegionBoundary[];
    manifest?: WorkspacePackage['manifest'];
  } = {},
) {
  const temporaryDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-ambient-')),
  );
  const rootDir = path.join(temporaryDir, 'workspace');
  await mkdir(rootDir, { recursive: true });
  const workspacePackage: WorkspacePackage = {
    directory: rootDir,
    manifest: { name: 'root', private: true, ...options.manifest },
    name: 'root',
  };
  const boundaries = options.boundaries ?? [];
  const workspaceContext = createWorkspaceContext({
    boundaries,
    configRootDir: rootDir,
    packages: [workspacePackage],
  });
  return {
    boundaries,
    cleanup: () => rm(temporaryDir, { force: true, recursive: true }),
    rootDir,
    workspacePackage,
    workspaceContext,
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
        workspaceContext: context.workspaceContext,
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
          workspaceContext: context.workspaceContext,
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
        workspaceContext: {
          ...context.workspaceContext,
          boundaries: [boundary],
          outputRoots: [path.join(context.rootDir, 'dist')],
          sourceConfigPaths: [tsconfig],
        },
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

  it('filters config-root-relative rules over activated external package candidates only', async () => {
    const context = await createContext();
    try {
      const externalRoot = path.join(path.dirname(context.rootDir), 'external');
      const inactiveRoot = path.join(path.dirname(context.rootDir), 'inactive');
      const externalFile = await writeText(
        externalRoot,
        'shared.d.ts',
        'interface ExternalShared {}\n',
      );
      await writeText(
        inactiveRoot,
        'hidden.d.ts',
        'interface InactiveHidden {}\n',
      );
      const externalPackage: WorkspacePackage = {
        directory: externalRoot,
        manifest: { name: 'external', private: true },
        name: 'external',
      };
      const workspaceContext = createWorkspaceContext({
        configRootDir: context.rootDir,
        packages: [context.workspacePackage, externalPackage],
      });
      const result = await createAmbientDeclarationIndex({
        config: createConfig(context.rootDir, [
          {
            include: ['../external/**/*.d.ts'],
            reason: 'Shared external fixture declarations.',
          },
          {
            include: ['../inactive/**/*.d.ts'],
            reason: 'Inactive files must remain invisible.',
          },
        ]),
        generatedGraph: createGraph(),
        workspaceContext,
      });

      expect(result.index.has(externalFile)).toBe(true);
      expect(result.issues).toHaveLength(1);
      expect(
        result.issues[0] && 'reason' in result.issues[0]
          ? result.issues[0].reason
          : undefined,
      ).toBe(
        'ambient declaration rules must match at least one existing declaration file.',
      );
    } finally {
      await context.cleanup();
    }
  });

  it('applies negative patterns only within the activated candidate universe', async () => {
    const context = await createContext();
    try {
      const sharedFile = await writeText(
        context.rootDir,
        'shared.d.ts',
        'interface Shared {}\n',
      );
      const privateFile = await writeText(
        context.rootDir,
        'private.d.ts',
        'interface Private {}\n',
      );
      const result = await createAmbientDeclarationIndex({
        config: createConfig(context.rootDir, [
          {
            include: ['**/*.d.ts', '!private.d.ts'],
            reason: 'Only the shared declaration is ambient.',
          },
        ]),
        generatedGraph: createGraph(),
        workspaceContext: context.workspaceContext,
      });

      expect(result.issues).toEqual([]);
      expect(result.index.has(sharedFile)).toBe(true);
      expect(result.index.has(privateFile)).toBe(false);
    } finally {
      await context.cleanup();
    }
  });
});
