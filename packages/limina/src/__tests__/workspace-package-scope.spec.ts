import type {
  PackageManifest,
  PackageOwner,
  WorkspacePackage,
} from '#core/workspace/actions';
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
import { describe, expect, it } from 'vitest';
import { createWorkspaceLookupIndex } from '../core/workspace/lookup';
import { WorkspacePackageScopeLookup } from '../core/workspace/lookup/package-scope';
import { WorkspaceLookupRegion } from '../core/workspace/lookup/region';
import {
  collectValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../core/workspace/validated-context';
import { createFixturePathResolver } from './helpers/path';

async function createFixture() {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-package-scope-')),
  );
  const fixturePath = createFixturePathResolver(rootDir);
  const writeManifest = async (
    directory: string,
    manifest: PackageManifest,
  ) => {
    await mkdir(fixturePath(directory), { recursive: true });
    await writeFile(
      fixturePath(directory, 'package.json'),
      JSON.stringify(manifest),
    );
  };
  const link = async (target: string, alias: string) => {
    await symlink(
      fixturePath(target),
      fixturePath(alias),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  };
  await writeManifest('workspace', { name: 'workspace', private: true });
  await writeFile(
    fixturePath('workspace/pnpm-workspace.yaml'),
    'packages: []\n',
  );
  await writeManifest('physical', { name: 'outside-parent', private: true });
  await writeManifest('physical/pkg', { private: true });
  await mkdir(fixturePath('physical/pkg/src'), { recursive: true });
  await link('physical/pkg', 'workspace/alias');
  await link('physical/pkg/src', 'workspace/source-alias');
  return {
    cleanup: () => rm(rootDir, { force: true, recursive: true }),
    link,
    path: fixturePath,
    rootDir,
    writeManifest,
  };
}

async function createLookups(options: {
  directory: string;
  extendNestedPackageScopes?: boolean;
  manifest?: PackageManifest;
  rootDir: string;
}) {
  const manifest = options.manifest ?? { private: true };
  const workspacePackage: WorkspacePackage = {
    directory: options.directory,
    manifest,
    ...(manifest.name ? { name: manifest.name } : {}),
  };
  const owner: PackageOwner = {
    ...workspacePackage,
    packageJsonPath: `${options.directory}/package.json`,
  };
  const context = await collectValidatedWorkspaceContext({
    config: {
      configPath: `${options.rootDir}/limina.config.mjs`,
      regions: {
        extendNestedPackageScopes: options.extendNestedPackageScopes ?? false,
      },
      rootDir: options.rootDir,
    },
    rawPackages: [workspacePackage],
  });
  const pathIndex = new WorkspaceRegionPathIndex(context);
  const scope = new WorkspacePackageScopeLookup({
    namedPackagesByName: new Map(),
    packagesByPackageJsonPath: new Map([
      [owner.packageJsonPath, workspacePackage],
    ]),
    region: new WorkspaceLookupRegion(options.rootDir, pathIndex),
  });
  const lookup = createWorkspaceLookupIndex({
    importers: [],
    owners: [owner],
    packages: [workspacePackage],
    pathIndex,
    rootDir: options.rootDir,
  });
  return { lookup, owner, pathIndex, scope, workspacePackage };
}

describe('WorkspacePackageScopeLookup canonical bounds', () => {
  it.each([
    ['workspace/alias', false],
    ['workspace/alias', true],
    ['physical/pkg', false],
    ['physical/pkg', true],
  ] as const)(
    'bounds nameless scope at %s with reversed queries=%s',
    async (directory, reverse) => {
      const fixture = await createFixture();
      try {
        const { lookup, owner, pathIndex, scope, workspacePackage } =
          await createLookups({
            directory: fixture.path(directory),
            rootDir: fixture.path('workspace'),
          });
        const queries = [
          'workspace/alias',
          'physical/pkg',
          'workspace/source-alias/missing/deep',
        ];
        for (const query of reverse ? queries.toReversed() : queries) {
          const filePath = fixture.path(query, 'missing.ts');
          expect(pathIndex.findPackageForPath(filePath)).toBe(workspacePackage);
          expect(
            scope.findNearestNamedPackageInfo(fixture.path(query)),
          ).toBeNull();
          const packageInfo = lookup.findNearestPackageScopeInfo(filePath);
          expect(packageInfo).toEqual(owner);
          expect(scope.findWorkspacePackageForInfo(packageInfo!)).toBe(
            workspacePackage,
          );
          expect(
            lookup.classifyResolvedPackageTarget({
              owner,
              resolvedFilePath: filePath,
            }),
          ).toEqual({ kind: 'current-owner', packageInfo: owner });
          expect(
            scope.findNearestNamedPackageInfo(fixture.path(query)),
          ).toBeNull();
        }
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each(['workspace/alias', 'physical/pkg'])(
    'retains named manifests and package identity at %s through a subtree alias',
    async (directory) => {
      const fixture = await createFixture();
      try {
        const manifest = { name: 'inner', private: true };
        await fixture.writeManifest('physical/pkg', manifest);
        const { lookup, owner, scope, workspacePackage } = await createLookups({
          directory: fixture.path(directory),
          manifest,
          rootDir: fixture.path('workspace'),
        });
        const directoryPath = fixture.path('workspace/source-alias/missing');
        const info = scope.findNearestNamedPackageInfo(directoryPath);
        expect(info).toEqual(owner);
        expect(scope.findWorkspacePackageForInfo(info!)).toBe(workspacePackage);
        const otherOwner = {
          ...owner,
          packageJsonPath: fixture.path('workspace/package.json'),
        };
        expect(
          lookup.classifyResolvedPackageTarget({
            owner: otherOwner,
            resolvedFilePath: `${directoryPath}/missing.ts`,
          }),
        ).toEqual({
          kind: 'other-owner',
          packageInfo: owner,
          targetOwner: owner,
          workspacePackage,
        });
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('finds the nearest accepted nested scope through a subtree alias', async () => {
    const fixture = await createFixture();
    try {
      const manifest = { name: 'inner', private: true };
      await fixture.writeManifest('physical/pkg', manifest);
      await fixture.writeManifest('physical/pkg/src', { private: true });
      await fixture.writeManifest('physical/pkg/src/nameless', {
        private: true,
      });
      await fixture.link('physical/pkg/src/nameless', 'workspace/deep-alias');
      const { lookup, scope } = await createLookups({
        directory: fixture.path('workspace/alias'),
        extendNestedPackageScopes: true,
        manifest,
        rootDir: fixture.path('workspace'),
      });
      expect(
        scope.findNearestNamedPackageInfo(
          fixture.path('workspace/deep-alias/missing'),
        ),
      ).toMatchObject({
        name: 'inner',
        packageJsonPath: fixture.path('workspace/alias/package.json'),
      });
      expect(
        lookup.findNearestPackageScopeInfo(
          fixture.path('workspace/deep-alias/missing/file.ts'),
        ),
      ).toMatchObject({
        manifest: { private: true },
        packageJsonPath: fixture.path(
          'workspace/alias/src/nameless/package.json',
        ),
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not admit a nested boundary or an inactive external directory', async () => {
    const fixture = await createFixture();
    try {
      await fixture.writeManifest('physical/pkg/src', { name: 'cut' });
      const { lookup, owner, pathIndex, scope } = await createLookups({
        directory: fixture.path('workspace/alias'),
        rootDir: fixture.path('workspace'),
      });
      for (const directory of [
        'workspace/source-alias/missing',
        'physical/pkg/src',
        'physical',
      ]) {
        const filePath = fixture.path(directory, 'file.ts');
        expect(pathIndex.findPackageForPath(filePath)).toBeNull();
        expect(
          scope.findNearestNamedPackageInfo(fixture.path(directory)),
        ).toBeNull();
        expect(lookup.findNearestPackageScopeInfo(filePath)).toBeNull();
        expect(
          lookup.classifyResolvedPackageTarget({
            owner,
            resolvedFilePath: filePath,
          }),
        ).toEqual({ kind: 'unowned' });
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([{}, { name: 'external' }])(
    'preserves node_modules package scope: %j',
    async (manifest) => {
      const fixture = await createFixture();
      try {
        await mkdir(fixture.path('workspace/node_modules/@scope'), {
          recursive: true,
        });
        await fixture.writeManifest('external', manifest);
        await fixture.link('external', 'workspace/node_modules/@scope/pkg');
        const { lookup, owner, scope } = await createLookups({
          directory: fixture.path('workspace/alias'),
          rootDir: fixture.path('workspace'),
        });
        const directory = fixture.path(
          'workspace/node_modules/@scope/pkg/missing',
        );
        const packageInfo = {
          directory: fixture.path('workspace/node_modules/@scope/pkg'),
          manifest,
          ...manifest,
          packageJsonPath: fixture.path(
            'workspace/node_modules/@scope/pkg/package.json',
          ),
        };
        expect(scope.findNearestNamedPackageInfo(directory)).toEqual(
          packageInfo,
        );
        expect(
          lookup.classifyResolvedPackageTarget({
            owner,
            resolvedFilePath: `${directory}/file.ts`,
          }),
        ).toEqual({ kind: 'artifact-package', packageInfo });
      } finally {
        await fixture.cleanup();
      }
    },
  );
});
