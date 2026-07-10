import {
  type ImporterInfo,
  type PackageManifest,
  type PackageOwner,
  type WorkspacePackage,
} from '#core/workspace/actions';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorkspaceLookupIndex } from '../core/workspace/lookup';
import { toPortablePath } from './helpers/path';

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

function stringifyConfig(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function createFixture(files: Record<string, string>): Promise<{
  cleanup: () => Promise<void>;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-workspace-lookup-')),
  );

  for (const [relativePath, text] of Object.entries(files)) {
    await writeText(path.join(rootDir, relativePath), text);
  }

  return {
    cleanup: async () => {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    },
    rootDir,
  };
}

function createWorkspacePackage(
  rootDir: string,
  relativeDirectory: string,
  manifest: PackageManifest,
): WorkspacePackage {
  return {
    directory: path.join(rootDir, relativeDirectory),
    manifest,
    ...(manifest.name ? { name: manifest.name } : {}),
  };
}

function createOwner(
  rootDir: string,
  relativeDirectory: string,
  manifest: PackageManifest,
): PackageOwner {
  return {
    directory: path.join(rootDir, relativeDirectory),
    manifest,
    ...(manifest.name ? { name: manifest.name } : {}),
    packageJsonPath: path.join(rootDir, relativeDirectory, 'package.json'),
  };
}

function createImporter(options: {
  dependencies?: string[];
  name?: string;
  rootDir: string;
  relativeDirectory: string;
}): ImporterInfo {
  return {
    declaredWorkspaceDependencies: new Set(options.dependencies),
    directory: path.join(options.rootDir, options.relativeDirectory),
    ...(options.name ? { name: options.name } : {}),
  };
}

describe('WorkspaceLookupIndex', () => {
  it('uses the nearest workspace package and owner for nested packages', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({ name: 'root' }),
      'packages/app/package.json': stringifyConfig({ name: '@acme/app' }),
      'packages/app/plugins/local/package.json': stringifyConfig({
        name: '@acme/local-plugin',
      }),
    });

    try {
      const rootPackage = createWorkspacePackage(fixture.rootDir, '.', {
        name: 'root',
      });
      const appPackage = createWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        {
          name: '@acme/app',
        },
      );
      const nestedPackage = createWorkspacePackage(
        fixture.rootDir,
        'packages/app/plugins/local',
        {
          name: '@acme/local-plugin',
        },
      );
      const index = createWorkspaceLookupIndex({
        importers: [],
        owners: [
          createOwner(fixture.rootDir, '.', { name: 'root' }),
          createOwner(fixture.rootDir, 'packages/app', {
            name: '@acme/app',
          }),
          createOwner(fixture.rootDir, 'packages/app/plugins/local', {
            name: '@acme/local-plugin',
          }),
        ],
        packages: [rootPackage, appPackage, nestedPackage],
        rootDir: fixture.rootDir,
      });
      const filePath = path.join(
        fixture.rootDir,
        'packages/app/plugins/local/src/index.ts',
      );

      expect(index.findPackageForFile(filePath)).toBe(nestedPackage);
      expect(index.findOwnerForFile(filePath)?.name).toBe('@acme/local-plugin');
      expect(
        index.findPackageForFile(path.join(fixture.rootDir, 'README.md')),
      ).toBe(rootPackage);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps nameless packages as owners and scopes without specifier hits', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({ name: 'root' }),
      'packages/nameless/package.json': stringifyConfig({ private: true }),
    });

    try {
      const namelessPackage = createWorkspacePackage(
        fixture.rootDir,
        'packages/nameless',
        {
          private: true,
        },
      );
      const namelessOwner = createOwner(fixture.rootDir, 'packages/nameless', {
        private: true,
      });
      const index = createWorkspaceLookupIndex({
        importers: [],
        owners: [
          createOwner(fixture.rootDir, '.', { name: 'root' }),
          namelessOwner,
        ],
        packages: [
          createWorkspacePackage(fixture.rootDir, '.', { name: 'root' }),
          namelessPackage,
        ],
        rootDir: fixture.rootDir,
      });
      const filePath = path.join(
        fixture.rootDir,
        'packages/nameless/src/index.ts',
      );

      expect(index.findPackageForFile(filePath)).toBe(namelessPackage);
      expect(index.findOwnerForFile(filePath)).toBe(namelessOwner);
      expect(index.findNearestPackageScopeInfo(filePath)?.name).toBeUndefined();
      expect(index.findPackageForSpecifier('packages/nameless')).toBeNull();
      expect(index.findPackageForSpecifier('root')).not.toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it('preserves importer collection order for importer lookup', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({ name: 'root' }),
      'packages/app/package.json': stringifyConfig({ name: '@acme/app' }),
    });

    try {
      const rootPackage = createWorkspacePackage(fixture.rootDir, '.', {
        name: 'root',
      });
      const appPackage = createWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        {
          name: '@acme/app',
        },
      );
      const rootImporter = createImporter({
        dependencies: ['@acme/app'],
        name: 'root',
        relativeDirectory: '.',
        rootDir: fixture.rootDir,
      });
      const appImporter = createImporter({
        name: '@acme/app',
        relativeDirectory: 'packages/app',
        rootDir: fixture.rootDir,
      });
      const index = createWorkspaceLookupIndex({
        importers: [rootImporter, appImporter],
        owners: [],
        packages: [rootPackage, appPackage],
        rootDir: fixture.rootDir,
      });

      expect(
        index.findImporterForFile(
          path.join(fixture.rootDir, 'packages/app/src/index.ts'),
        ),
      ).toBe(rootImporter);
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses nearest package scopes for nested manifests and node_modules packages', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({ name: 'root' }),
      'packages/app/package.json': stringifyConfig({ name: '@acme/app' }),
      'packages/app/src/feature/package.json': stringifyConfig({
        imports: {
          '#internal': './index.ts',
        },
        private: true,
      }),
      'packages/app/node_modules/@scope/pkg/package.json': stringifyConfig({
        name: '@scope/pkg',
      }),
    });

    try {
      const appPackage = createWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        {
          name: '@acme/app',
        },
      );
      const index = createWorkspaceLookupIndex({
        importers: [],
        owners: [],
        packages: [appPackage],
        rootDir: fixture.rootDir,
      });

      expect(
        toPortablePath(
          index.findNearestPackageScopeInfo(
            path.join(fixture.rootDir, 'packages/app/src/feature/index.ts'),
          )?.packageJsonPath ?? '',
        ),
      ).toBe(
        toPortablePath(
          path.join(fixture.rootDir, 'packages/app/src/feature/package.json'),
        ),
      );
      expect(
        index.findNearestPackageScopeInfo(
          path.join(
            fixture.rootDir,
            'packages/app/node_modules/@scope/pkg/index.d.ts',
          ),
        )?.name,
      ).toBe('@scope/pkg');
    } finally {
      await fixture.cleanup();
    }
  });

  it('classifies current-owner, other-owner, and artifact package targets', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({ name: 'root' }),
      'packages/app/package.json': stringifyConfig({ name: '@acme/app' }),
      'packages/lib/package.json': stringifyConfig({ name: '@acme/lib' }),
      'packages/app/node_modules/external/package.json': stringifyConfig({
        name: 'external',
      }),
      'tools/loose/package.json': stringifyConfig({ name: '@acme/loose' }),
    });

    try {
      const appPackage = createWorkspacePackage(
        fixture.rootDir,
        'packages/app',
        {
          name: '@acme/app',
        },
      );
      const libPackage = createWorkspacePackage(
        fixture.rootDir,
        'packages/lib',
        {
          name: '@acme/lib',
        },
      );
      const appOwner = createOwner(fixture.rootDir, 'packages/app', {
        name: '@acme/app',
      });
      const libOwner = createOwner(fixture.rootDir, 'packages/lib', {
        name: '@acme/lib',
      });
      const index = createWorkspaceLookupIndex({
        importers: [],
        owners: [appOwner, libOwner],
        packages: [appPackage, libPackage],
        rootDir: fixture.rootDir,
      });

      expect(
        index.classifyResolvedPackageTarget({
          owner: appOwner,
          resolvedFilePath: path.join(fixture.rootDir, 'packages/app/src.ts'),
        }).kind,
      ).toBe('current-owner');
      expect(
        index.classifyResolvedPackageTarget({
          owner: appOwner,
          resolvedFilePath: path.join(fixture.rootDir, 'packages/lib/src.ts'),
        }),
      ).toMatchObject({
        kind: 'other-owner',
        targetOwner: libOwner,
        workspacePackage: libPackage,
      });
      expect(
        index.classifyResolvedPackageTarget({
          owner: appOwner,
          resolvedFilePath: path.join(
            fixture.rootDir,
            'packages/app/node_modules/external/index.d.ts',
          ),
        }),
      ).toMatchObject({
        kind: 'artifact-package',
        packageInfo: {
          name: 'external',
        },
      });
      expect(
        index.classifyResolvedPackageTarget({
          owner: appOwner,
          resolvedFilePath: path.join(fixture.rootDir, 'tools/loose/index.ts'),
        }).kind,
      ).toBe('unowned');
    } finally {
      await fixture.cleanup();
    }
  });
});
