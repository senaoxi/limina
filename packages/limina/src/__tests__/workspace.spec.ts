import type { ResolvedLiminaConfig } from '#config/runner';
import { createAnalysisProviders } from '#core';
import type {
  PackageManifest,
  WorkspacePackage,
} from '#core/workspace/actions';
import {
  collectPackageOwners,
  collectRawWorkspacePackages,
  collectWorkspacePackages,
} from '#core/workspace/actions';
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  collectWorkspaceRegionBoundaries,
  collectWorkspaceRegionTopology,
  getWorkspaceRegionBoundaryExclusionReason,
  isWorkspaceRegionBoundaryExcluded,
} from '../core/workspace/regions';
import {
  type ValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../core/workspace/validated-context';
import {
  createFixturePathResolver,
  toPortableRelativePath,
} from './helpers/path';

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

function stringifyConfig(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function createWorkspacePackageFixture(
  rootDir: string,
  relativeDirectory: string,
  manifest: PackageManifest,
): WorkspacePackage {
  return {
    directory: path.join(rootDir, relativeDirectory),
    manifest,
    ...(typeof manifest.name === 'string' && manifest.name.trim().length > 0
      ? { name: manifest.name.trim() }
      : {}),
  };
}

async function createFixture(files: Record<string, string>): Promise<{
  cleanup: () => Promise<void>;
  config: ResolvedLiminaConfig;
  path: (...segments: string[]) => string;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-workspace-')),
  );
  const fixturePath = createFixturePathResolver(rootDir);

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
    config: {
      configPath: fixturePath('limina.config.mjs'),
      rootDir,
    },
    path: fixturePath,
    rootDir,
  };
}

describe('collectWorkspacePackages', () => {
  it('collects workspace packages without names', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({
        name: 'root',
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/a/package.json': stringifyConfig({
        private: true,
      }),
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    });

    try {
      const packages = await collectWorkspacePackages(fixture.config);

      expect(
        packages.map((workspacePackage) => ({
          directory: toPortableRelativePath(
            fixture.rootDir,
            workspacePackage.directory,
          ),
          name: workspacePackage.name,
        })),
      ).toEqual(
        expect.arrayContaining([
          {
            directory: '',
            name: 'root',
          },
          {
            directory: 'packages/a',
            name: undefined,
          },
        ]),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('treats blank workspace package names as nameless and keeps deterministic order', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({
        name: 'root',
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/a/package.json': stringifyConfig({
        name: '@example/a',
        private: true,
      }),
      'packages/b/package.json': stringifyConfig({
        name: '   ',
        private: true,
      }),
      'packages/z/package.json': stringifyConfig({
        name: '@example/z',
        private: true,
      }),
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    });

    try {
      const packages = await collectWorkspacePackages(fixture.config);

      expect(
        packages.map((workspacePackage) => ({
          directory: toPortableRelativePath(
            fixture.rootDir,
            workspacePackage.directory,
          ),
          name: workspacePackage.name,
        })),
      ).toEqual([
        {
          directory: 'packages/a',
          name: '@example/a',
        },
        {
          directory: 'packages/z',
          name: '@example/z',
        },
        {
          directory: '',
          name: 'root',
        },
        {
          directory: 'packages/b',
          name: undefined,
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('discovers only package.json manifests selected by workspace patterns', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({ name: 'root', private: true }),
      'packages/excluded/package.json': stringifyConfig({
        name: '@example/excluded',
      }),
      'packages/json/package.json': stringifyConfig({
        name: '@example/json',
      }),
      'packages/json/package.json5': "{ name: '@example/json5-shadow' }\n",
      'packages/json/package.yaml': 'name: @example/yaml-shadow\n',
      'packages/json5/package.json5': "{ name: '@example/json5' }\n",
      'packages/yaml/package.yaml': 'name: @example/yaml\n',
      'pnpm-workspace.yaml': [
        'packages:',
        '  - packages/*',
        '  - "!packages/excluded"',
        '',
      ].join('\n'),
    });

    try {
      const packages = await collectRawWorkspacePackages(fixture.config);
      const owners = await collectPackageOwners(fixture.config);

      await Promise.all(owners.map((owner) => access(owner.packageJsonPath)));

      expect(packages.map((workspacePackage) => workspacePackage.name)).toEqual(
        ['@example/json', 'root'],
      );
      expect(
        owners.map((owner) =>
          toPortableRelativePath(fixture.rootDir, owner.packageJsonPath),
        ),
      ).toEqual(
        expect.arrayContaining(['package.json', 'packages/json/package.json']),
      );
      expect(
        owners.every((owner) => owner.packageJsonPath.endsWith('package.json')),
      ).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses pnpm default ignores for invalid test fixture manifests', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({ name: 'root', private: true }),
      'packages/a/package.json': stringifyConfig({
        name: '@example/a',
        private: true,
      }),
      'packages/a/test/fixture/package.json': '{\n',
      'pnpm-workspace.yaml': 'packages:\n  - packages/**\n',
    });

    try {
      const packages = await collectWorkspacePackages(fixture.config);

      expect(packages.map((workspacePackage) => workspacePackage.name)).toEqual(
        ['@example/a', 'root'],
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('validates the root workspace manifest with the pnpm reader', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({ name: 'root', private: true }),
      'pnpm-workspace.yaml': 'packages: []\ncatalogs: []\n',
    });

    try {
      await expect(
        collectRawWorkspacePackages(fixture.config),
      ).rejects.toMatchObject({
        code: 'ERR_PNPM_INVALID_WORKSPACE_CONFIGURATION',
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps an excluded overlap in raw evidence but removes activated authority', async () => {
    const fixture = await createFixture({
      'app/package.json': stringifyConfig({
        name: '@example/app',
        private: true,
      }),
      'app/pnpm-workspace.yaml': 'packages: []\n',
      'package.json': stringifyConfig({
        dependencies: {
          '@example/app': 'workspace:*',
        },
        name: 'root',
        private: true,
      }),
      'pnpm-workspace.yaml': 'packages:\n  - app\n',
    });

    try {
      fixture.config.regions = {
        exclude: [
          {
            include: ['app/**'],
            kind: 'workspace-package',
            reason: 'Nested app workspace is checked separately.',
          },
        ],
      };

      const core = createAnalysisProviders(fixture.config);
      const rawPackages = await core.workspace.getRawPackages();

      expect(
        rawPackages.map((workspacePackage) => workspacePackage.name),
      ).toEqual(expect.arrayContaining(['@example/app']));
      await expect(core.workspace.getPackages()).resolves.not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: '@example/app' }),
        ]),
      );
      await expect(
        core.workspace.findPackageBySpecifier('@example/app'),
      ).resolves.toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('collectWorkspaceRegionBoundaries', () => {
  it('discovers nested pnpm workspaces as unconditional island boundaries', async () => {
    const fixture = await createFixture({
      '.limina/generated/pnpm-workspace.yaml': 'packages: []\n',
      '.git/modules/pnpm-workspace.yaml': 'packages: []\n',
      'node_modules/pkg/pnpm-workspace.yaml': 'packages: []\n',
      'package.json': stringifyConfig({
        name: 'root',
        private: true,
      }),
      'packages/a/fixture/pnpm-workspace.yaml': 'packages: []\n',
      'packages/a/package.json': stringifyConfig({
        name: '@example/a',
        private: true,
      }),
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    });

    try {
      const boundaries = await collectWorkspaceRegionBoundaries(
        fixture.config,
        collectRawWorkspacePackages,
      );

      expect(
        boundaries.map((boundary) => ({
          excluded: isWorkspaceRegionBoundaryExcluded(boundary),
          reason: getWorkspaceRegionBoundaryExclusionReason(boundary),
          root: toPortableRelativePath(fixture.rootDir, boundary.rootDir),
        })),
      ).toEqual([
        {
          excluded: true,
          reason: 'Nested workspace context is discovered independently.',
          root: 'packages/a/fixture',
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not inspect a nested pnpm workspace manifest in the parent run', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({
        name: 'root',
        private: true,
      }),
      'packages/a/fixture/pnpm-workspace.yaml': 'packages: []\ncatalogs: []\n',
      'packages/a/package.json': stringifyConfig({
        name: '@example/a',
        private: true,
      }),
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    });

    try {
      await expect(
        collectWorkspaceRegionBoundaries(
          fixture.config,
          collectRawWorkspacePackages,
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          kind: 'pnpm-workspace',
          rootDir: fixture.path('packages/a/fixture'),
        }),
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('stops at the first nested workspace without inspecting descendants', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({ name: 'root', private: true }),
      'packages/a/fixture/deeper/pnpm-workspace.yaml':
        'packages: []\ncatalogs: []\n',
      'packages/a/fixture/package.json': '{\n',
      'packages/a/fixture/pnpm-workspace.yaml': 'packages: []\ncatalogs: []\n',
      'packages/a/package.json': stringifyConfig({
        name: '@example/a',
        private: true,
      }),
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    });
    const provider = vi.fn(async () => {
      throw new Error('excluded workspace provider must not run');
    });

    try {
      const workspacePackage = createWorkspacePackageFixture(
        fixture.rootDir,
        'packages/a',
        { name: '@example/a', private: true },
      );
      const topology = await collectWorkspaceRegionTopology(fixture.config, {
        provider,
        rawPackages: [workspacePackage],
      });

      expect(provider).not.toHaveBeenCalled();
      expect(topology.boundaries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            inspection: {
              reason: 'Nested workspace context is discovered independently.',
              status: 'excluded',
            },
            kind: 'pnpm-workspace',
            rootDir: fixture.path('packages/a/fixture'),
          }),
        ]),
      );
      expect(topology.boundaries).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores nested pnpm workspaces inside configured output directories', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({
        name: 'root',
        private: true,
      }),
      'packages/a/generated/pnpm-workspace.yaml': 'packages: []\n',
      'packages/a/package.json': stringifyConfig({
        name: '@example/a',
        private: true,
      }),
      'packages/a/tsconfig.json': stringifyConfig({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
        liminaOptions: {
          outputs: {
            outDir: 'generated',
          },
        },
      }),
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    });

    try {
      await expect(
        collectWorkspaceRegionBoundaries(
          fixture.config,
          collectRawWorkspacePackages,
        ),
      ).resolves.toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not let nested-region tsconfig outDir hide its own workspace boundary', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({
        name: 'root',
        private: true,
      }),
      'packages/a/fixture/pnpm-workspace.yaml': 'packages: []\n',
      'packages/a/fixture/tsconfig.json': stringifyConfig({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
        liminaOptions: {
          outputs: {
            outDir: '.',
          },
        },
      }),
      'packages/a/package.json': stringifyConfig({
        name: '@example/a',
        private: true,
      }),
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    });

    try {
      const boundaries = await collectWorkspaceRegionBoundaries(
        fixture.config,
        collectRawWorkspacePackages,
      );

      expect(boundaries.map((boundary) => boundary.rootDir)).toEqual([
        fixture.path('packages/a/fixture'),
      ]);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('collectWorkspaceRegionTopology', () => {
  it('stops at the first nested package scope by default', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({ name: 'root', private: true }),
      'packages/a/package.json': stringifyConfig({
        name: '@example/a',
        private: true,
      }),
      'packages/a/src/nested/deeper/package.json': stringifyConfig({
        private: true,
      }),
      'packages/a/src/nested/package.json': stringifyConfig({ private: true }),
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    });

    try {
      const rawPackages = [
        createWorkspacePackageFixture(fixture.rootDir, 'packages/a', {
          name: '@example/a',
          private: true,
        }),
      ];
      const topology = await collectWorkspaceRegionTopology(fixture.config, {
        provider: async () => [],
        rawPackages,
      });

      expect(
        topology.boundaries.map((boundary) =>
          toPortableRelativePath(
            fixture.rootDir,
            boundary.kind === 'package-scope'
              ? boundary.packageJsonPath
              : boundary.workspaceYamlPath,
          ),
        ),
      ).toEqual(['packages/a/src/nested/package.json']);
      expect(topology.extendedPackageScopes).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('extends consecutive eligible manifests but stops when name is present', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({ name: 'root', private: true }),
      'packages/a/package.json': stringifyConfig({
        name: '@example/a',
        private: true,
      }),
      'packages/a/src/empty-name/package.json': stringifyConfig({ name: '' }),
      'packages/a/src/nested/deeper/package.json': stringifyConfig({
        private: true,
      }),
      'packages/a/src/nested/package.json': stringifyConfig({ private: true }),
      'packages/a/src/null-name/package.json': stringifyConfig({ name: null }),
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    });

    try {
      const config = {
        ...fixture.config,
        regions: {
          extendNestedPackageScopes: true,
        },
      };
      const topology = await collectWorkspaceRegionTopology(config, {
        provider: async () => [],
        rawPackages: [
          createWorkspacePackageFixture(fixture.rootDir, 'packages/a', {
            name: '@example/a',
            private: true,
          }),
        ],
      });

      expect(
        topology.extendedPackageScopes.map((scope) =>
          toPortableRelativePath(fixture.rootDir, scope.packageJsonPath),
        ),
      ).toEqual([
        'packages/a/src/nested/package.json',
        'packages/a/src/nested/deeper/package.json',
      ]);
      expect(
        topology.boundaries.map((boundary) =>
          toPortableRelativePath(
            fixture.rootDir,
            boundary.kind === 'package-scope'
              ? boundary.packageJsonPath
              : boundary.workspaceYamlPath,
          ),
        ),
      ).toEqual([
        'packages/a/src/empty-name/package.json',
        'packages/a/src/null-name/package.json',
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not read a nested workspace context to claim parent-island manifests', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({ name: 'root', private: true }),
      'packages/a/package.json': stringifyConfig({
        name: '@example/a',
        private: true,
      }),
      'packages/a/src/claimed/package.json': stringifyConfig({ private: true }),
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      'tools/package.json': stringifyConfig({ name: 'tools', private: true }),
      'tools/pnpm-workspace.yaml': 'packages: []\n',
    });

    try {
      const claimedPackage = createWorkspacePackageFixture(
        fixture.rootDir,
        'packages/a/src/claimed',
        { private: true },
      );
      const provider = vi.fn(async () => [claimedPackage]);
      const topology = await collectWorkspaceRegionTopology(
        {
          ...fixture.config,
          regions: {
            extendNestedPackageScopes: true,
          },
        },
        {
          provider,
          rawPackages: [
            createWorkspacePackageFixture(fixture.rootDir, 'packages/a', {
              name: '@example/a',
              private: true,
            }),
          ],
        },
      );

      expect(
        topology.boundaries.some(
          (boundary) =>
            boundary.kind === 'package-scope' &&
            boundary.packageJsonPath ===
              fixture.path('packages/a/src/claimed/package.json'),
        ),
      ).toBe(false);
      expect(provider).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps nested pnpm workspaces hard even when extension is enabled', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({ name: 'root', private: true }),
      'packages/a/fixture/package.json': stringifyConfig({ private: true }),
      'packages/a/fixture/pnpm-workspace.yaml': 'packages: []\n',
      'packages/a/package.json': stringifyConfig({
        name: '@example/a',
        private: true,
      }),
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    });

    try {
      const topology = await collectWorkspaceRegionTopology(
        {
          ...fixture.config,
          regions: {
            extendNestedPackageScopes: true,
          },
        },
        {
          provider: async () => [],
          rawPackages: [
            createWorkspacePackageFixture(fixture.rootDir, 'packages/a', {
              name: '@example/a',
              private: true,
            }),
          ],
        },
      );

      expect(topology.extendedPackageScopes).toEqual([]);
      expect(topology.boundaries).toEqual([
        expect.objectContaining({
          kind: 'pnpm-workspace',
          rootDir: fixture.path('packages/a/fixture'),
        }),
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects exclude entries that do not match a recognized root', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({ name: 'root', private: true }),
      'packages/a/package.json': stringifyConfig({
        name: '@example/a',
        private: true,
      }),
      'packages/a/src/index.ts': 'export const value = 1;\n',
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    });

    try {
      await expect(
        collectWorkspaceRegionTopology(
          {
            ...fixture.config,
            regions: {
              exclude: [
                {
                  include: ['packages/a/src/**'],
                  kind: 'workspace-package',
                  reason: 'Ordinary directories are not governance roots.',
                },
              ],
            },
          },
          {
            provider: async () => [],
            rawPackages: [
              createWorkspacePackageFixture(fixture.rootDir, 'packages/a', {
                name: '@example/a',
                private: true,
              }),
            ],
          },
        ),
      ).rejects.toThrow(/does not match an exact governance candidate/u);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not match descriptor paths or a different candidate kind', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({ name: 'root', private: true }),
      'packages/a/package.json': stringifyConfig({
        name: '@example/a',
        private: true,
      }),
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    });
    const workspacePackage = createWorkspacePackageFixture(
      fixture.rootDir,
      'packages/a',
      { name: '@example/a', private: true },
    );

    try {
      for (const rule of [
        {
          include: ['packages/a/package.json'],
          kind: 'workspace-package' as const,
          reason: 'Descriptor paths are not selectors.',
        },
        {
          include: ['@example/a'],
          kind: 'workspace-package' as const,
          reason: 'Package names are not selectors.',
        },
      ]) {
        await expect(
          collectWorkspaceRegionTopology(
            { ...fixture.config, regions: { exclude: [rule] } },
            { provider: async () => [], rawPackages: [workspacePackage] },
          ),
        ).rejects.toThrow(/does not match an exact governance candidate/u);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects multiple rules that match the same candidate', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({ name: 'root', private: true }),
      'packages/a/package.json': stringifyConfig({
        name: '@example/a',
        private: true,
      }),
      'packages/a/src/nested/package.json': stringifyConfig({ private: true }),
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    });

    try {
      await expect(
        collectWorkspaceRegionTopology(
          {
            ...fixture.config,
            regions: {
              exclude: [
                {
                  include: ['packages/a/src/**'],
                  kind: 'package-scope',
                  reason: 'All nested scopes.',
                },
                {
                  include: ['packages/a/src/nested'],
                  kind: 'package-scope',
                  reason: 'The nested scope.',
                },
              ],
            },
          },
          {
            provider: async () => [],
            rawPackages: [
              createWorkspacePackageFixture(fixture.rootDir, 'packages/a', {
                name: '@example/a',
                private: true,
              }),
            ],
          },
        ),
      ).rejects.toThrow(
        /Multiple regions\.exclude rules match package-scope packages\/a\/src\/nested/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows exact root package exclusion without cascading to descendants', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({ name: 'root', private: true }),
      'packages/app/package.json': stringifyConfig({
        name: '@example/app',
        private: true,
      }),
      'pnpm-workspace.yaml': 'packages:\n  - packages/app\n',
    });

    try {
      const rootPackage = createWorkspacePackageFixture(fixture.rootDir, '.', {
        name: 'root',
        private: true,
      });
      const appPackage = createWorkspacePackageFixture(
        fixture.rootDir,
        'packages/app',
        { name: '@example/app', private: true },
      );
      const topology = await collectWorkspaceRegionTopology(
        {
          ...fixture.config,
          regions: {
            exclude: [
              {
                include: ['.'],
                kind: 'workspace-package',
                reason: 'Only the root package is excluded.',
              },
            ],
          },
        },
        { provider: async () => [], rawPackages: [rootPackage, appPackage] },
      );

      expect(
        topology.packages.map((workspacePackage) => workspacePackage.name),
      ).toEqual(['@example/app']);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports an activated package that is also a non-root workspace root', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({ name: 'root', private: true }),
      'packages/app/package.json': stringifyConfig({
        name: '@example/app',
        private: true,
      }),
      'packages/app/pnpm-workspace.yaml': 'packages: []\n',
      'pnpm-workspace.yaml': 'packages:\n  - packages/app\n',
    });

    try {
      await expect(
        collectWorkspaceRegionTopology(fixture.config, {
          provider: async () => [],
          rawPackages: [
            createWorkspacePackageFixture(fixture.rootDir, 'packages/app', {
              name: '@example/app',
              private: true,
            }),
          ],
        }),
      ).rejects.toMatchObject({
        issues: [
          expect.objectContaining({
            code: 'LIMINA_WORKSPACE_REGION_OVERLAP',
            filePath: 'packages/app/pnpm-workspace.yaml',
            reason:
              'An activated non-root workspace package is also the root of a pnpm workspace.',
          }),
        ],
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not let a package-scope rule suppress activated package overlap', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({ name: 'root', private: true }),
      'packages/app/package.json': stringifyConfig({
        name: '@example/app',
        private: true,
      }),
      'packages/app/pnpm-workspace.yaml': 'packages: []\n',
      'pnpm-workspace.yaml': 'packages:\n  - packages/app\n',
    });

    try {
      await expect(
        collectWorkspaceRegionTopology(
          {
            ...fixture.config,
            regions: {
              exclude: [
                {
                  include: ['packages/app'],
                  kind: 'package-scope',
                  reason: 'Package scopes do not remove package identity.',
                },
              ],
            },
          },
          {
            provider: async () => [],
            rawPackages: [
              createWorkspacePackageFixture(fixture.rootDir, 'packages/app', {
                name: '@example/app',
                private: true,
              }),
            ],
          },
        ),
      ).rejects.toMatchObject({
        issues: [
          expect.objectContaining({
            code: 'LIMINA_WORKSPACE_REGION_OVERLAP',
          }),
        ],
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('preserves an excluded overlap boundary and active descendant re-entry', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({ name: 'root', private: true }),
      'packages/parent/fixture/nested/package.json': stringifyConfig({
        name: '@example/nested',
        private: true,
      }),
      'packages/parent/fixture/nested/src/index.ts':
        'export const nested = true;\n',
      'packages/parent/fixture/package.json': stringifyConfig({
        name: '@example/fixture',
        private: true,
      }),
      'packages/parent/fixture/pnpm-workspace.yaml': 'packages: []\n',
      'packages/parent/fixture/src/index.ts': 'export const fixture = true;\n',
      'packages/parent/package.json': stringifyConfig({
        name: '@example/parent',
        private: true,
      }),
      'pnpm-workspace.yaml':
        'packages:\n  - packages/parent\n  - packages/parent/fixture\n  - packages/parent/fixture/nested\n',
    });

    try {
      const topology = await collectWorkspaceRegionTopology(
        {
          ...fixture.config,
          regions: {
            exclude: [
              {
                include: ['packages/parent/fixture'],
                kind: 'workspace-package',
                reason: 'The nested workspace is checked separately.',
              },
            ],
          },
        },
        {
          provider: async () => [],
          rawPackages: [
            createWorkspacePackageFixture(fixture.rootDir, 'packages/parent', {
              name: '@example/parent',
              private: true,
            }),
            createWorkspacePackageFixture(
              fixture.rootDir,
              'packages/parent/fixture',
              { name: '@example/fixture', private: true },
            ),
            createWorkspacePackageFixture(
              fixture.rootDir,
              'packages/parent/fixture/nested',
              { name: '@example/nested', private: true },
            ),
          ],
        },
      );
      const pathIndex = new WorkspaceRegionPathIndex(
        topology as ValidatedWorkspaceContext,
      );

      expect(
        topology.rawPackages.map((workspacePackage) => workspacePackage.name),
      ).toEqual(['@example/parent', '@example/fixture', '@example/nested']);
      expect(
        topology.packages.map((workspacePackage) => workspacePackage.name),
      ).toEqual(['@example/parent', '@example/nested']);
      expect(topology.boundaries).toEqual([
        expect.objectContaining({
          kind: 'pnpm-workspace',
          rootDir: fixture.path('packages/parent/fixture'),
        }),
      ]);
      expect(
        pathIndex.findPackageForPath(
          fixture.path('packages/parent/fixture/src/index.ts'),
        ),
      ).toBeNull();
      expect(
        pathIndex.findBoundaryForPath(
          fixture.path('packages/parent/fixture/src/index.ts'),
        ),
      ).toMatchObject({
        kind: 'pnpm-workspace',
        rootDir: fixture.path('packages/parent/fixture'),
      });
      expect(
        pathIndex.findPackageForPath(
          fixture.path('packages/parent/fixture/nested/src/index.ts'),
        )?.name,
      ).toBe('@example/nested');
      expect(
        pathIndex.findBoundaryForPath(
          fixture.path('packages/parent/fixture/nested/src/index.ts'),
        ),
      ).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it('validates unmatched workspace-package rules before overlap', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({ name: 'root', private: true }),
      'packages/app/package.json': stringifyConfig({
        name: '@example/app',
        private: true,
      }),
      'packages/app/pnpm-workspace.yaml': 'packages: []\n',
      'pnpm-workspace.yaml': 'packages:\n  - packages/app\n',
    });

    try {
      await expect(
        collectWorkspaceRegionTopology(
          {
            ...fixture.config,
            regions: {
              exclude: [
                {
                  include: ['packages/missing'],
                  kind: 'workspace-package',
                  reason: 'This rule is invalid.',
                },
              ],
            },
          },
          {
            provider: async () => [],
            rawPackages: [
              createWorkspacePackageFixture(fixture.rootDir, 'packages/app', {
                name: '@example/app',
                private: true,
              }),
            ],
          },
        ),
      ).rejects.toThrow(
        'regions.exclude[0] does not match an exact governance candidate.',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('validates duplicate workspace-package rules before overlap', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({ name: 'root', private: true }),
      'packages/app/package.json': stringifyConfig({
        name: '@example/app',
        private: true,
      }),
      'packages/app/pnpm-workspace.yaml': 'packages: []\n',
      'pnpm-workspace.yaml': 'packages:\n  - packages/app\n',
    });

    try {
      await expect(
        collectWorkspaceRegionTopology(
          {
            ...fixture.config,
            regions: {
              exclude: [
                {
                  include: ['packages/app'],
                  kind: 'workspace-package',
                  reason: 'First matching rule.',
                },
                {
                  include: ['packages/**'],
                  kind: 'workspace-package',
                  reason: 'Second matching rule.',
                },
              ],
            },
          },
          {
            provider: async () => [],
            rawPackages: [
              createWorkspacePackageFixture(fixture.rootDir, 'packages/app', {
                name: '@example/app',
                private: true,
              }),
            ],
          },
        ),
      ).rejects.toThrow(
        'Multiple regions.exclude rules match workspace-package packages/app.',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports an unrelated activated overlap after applying a valid exclusion', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({ name: 'root', private: true }),
      'packages/excluded/package.json': stringifyConfig({
        name: '@example/excluded',
        private: true,
      }),
      'packages/excluded/pnpm-workspace.yaml': 'packages: []\n',
      'packages/overlap/package.json': stringifyConfig({
        name: '@example/overlap',
        private: true,
      }),
      'packages/overlap/pnpm-workspace.yaml': 'packages: []\n',
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    });

    try {
      await expect(
        collectWorkspaceRegionTopology(
          {
            ...fixture.config,
            regions: {
              exclude: [
                {
                  include: ['packages/excluded'],
                  kind: 'workspace-package',
                  reason: 'This workspace is checked separately.',
                },
              ],
            },
          },
          {
            provider: async () => [],
            rawPackages: [
              createWorkspacePackageFixture(
                fixture.rootDir,
                'packages/excluded',
                { name: '@example/excluded', private: true },
              ),
              createWorkspacePackageFixture(
                fixture.rootDir,
                'packages/overlap',
                { name: '@example/overlap', private: true },
              ),
            ],
          },
        ),
      ).rejects.toMatchObject({
        issues: [
          expect.objectContaining({
            code: 'LIMINA_WORKSPACE_REGION_OVERLAP',
            filePath: 'packages/overlap/pnpm-workspace.yaml',
          }),
        ],
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('turns an excluded extended scope into a hard boundary', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({ name: 'root', private: true }),
      'packages/a/package.json': stringifyConfig({
        name: '@example/a',
        private: true,
      }),
      'packages/a/src/nested/package.json': stringifyConfig({ private: true }),
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    });

    try {
      const topology = await collectWorkspaceRegionTopology(
        {
          ...fixture.config,
          regions: {
            exclude: [
              {
                include: ['packages/a/src/nested/**'],
                kind: 'package-scope',
                reason: 'Nested fixture scope is not part of this run.',
              },
            ],
            extendNestedPackageScopes: true,
          },
        },
        {
          provider: async () => [],
          rawPackages: [
            createWorkspacePackageFixture(fixture.rootDir, 'packages/a', {
              name: '@example/a',
              private: true,
            }),
          ],
        },
      );

      expect(topology.extendedPackageScopes).toEqual([]);
      expect(topology.boundaries).toEqual([
        expect.objectContaining({
          excluded: true,
          exclusionReason: 'Nested fixture scope is not part of this run.',
          kind: 'package-scope',
          rootDir: fixture.path('packages/a/src/nested'),
        }),
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('stops traversal below an excluded package-scope candidate', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({ name: 'root', private: true }),
      'packages/a/package.json': stringifyConfig({
        name: '@example/a',
        private: true,
      }),
      'packages/a/src/nested/fixture/pnpm-workspace.yaml': 'packages: []\n',
      'packages/a/src/nested/package.json': stringifyConfig({ private: true }),
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    });

    try {
      const topology = await collectWorkspaceRegionTopology(
        {
          ...fixture.config,
          regions: {
            exclude: [
              {
                include: ['packages/a/src/nested'],
                kind: 'package-scope',
                reason: 'Nested fixtures are checked separately.',
              },
            ],
          },
        },
        {
          provider: async () => [],
          rawPackages: [
            createWorkspacePackageFixture(fixture.rootDir, 'packages/a', {
              name: '@example/a',
              private: true,
            }),
          ],
        },
      );

      expect(topology.boundaries).toEqual([
        expect.objectContaining({
          excluded: true,
          exclusionReason: 'Nested fixtures are checked separately.',
          kind: 'package-scope',
          rootDir: fixture.path('packages/a/src/nested'),
        }),
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps activated descendants when only their parent package scope is excluded', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({ name: 'root', private: true }),
      'packages/a/fixtures/child/package.json': stringifyConfig({
        name: '@example/child',
        private: true,
      }),
      'packages/a/fixtures/package.json': stringifyConfig({ private: true }),
      'packages/a/package.json': stringifyConfig({
        name: '@example/a',
        private: true,
      }),
      'pnpm-workspace.yaml': [
        'packages:',
        '  - packages/*',
        '  - packages/*/fixtures/*',
        '',
      ].join('\n'),
    });

    try {
      const parentPackage = createWorkspacePackageFixture(
        fixture.rootDir,
        'packages/a',
        { name: '@example/a', private: true },
      );
      const childPackage = createWorkspacePackageFixture(
        fixture.rootDir,
        'packages/a/fixtures/child',
        { name: '@example/child', private: true },
      );
      const topology = await collectWorkspaceRegionTopology(
        {
          ...fixture.config,
          regions: {
            exclude: [
              {
                include: ['packages/a/fixtures'],
                kind: 'package-scope',
                reason: 'Fixture container is an accepted package boundary.',
              },
            ],
          },
        },
        {
          provider: async () => [],
          rawPackages: [parentPackage, childPackage],
        },
      );
      const pathIndex = new WorkspaceRegionPathIndex(
        topology as ValidatedWorkspaceContext,
      );

      expect(
        topology.packages.map((workspacePackage) => workspacePackage.name),
      ).toEqual(['@example/a', '@example/child']);
      expect(topology.boundaries).toEqual([
        expect.objectContaining({
          excluded: true,
          exclusionReason: 'Fixture container is an accepted package boundary.',
          rootDir: fixture.path('packages/a/fixtures'),
        }),
      ]);
      expect(
        pathIndex.isInsideActivatedRegion(
          path.join(fixture.rootDir, 'packages/a/fixtures/child/src/index.ts'),
        ),
      ).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('excludes the root package without hiding deeper workspace packages', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({ name: 'root', private: true }),
      'packages/child/package.json': stringifyConfig({
        name: '@example/child',
        private: true,
      }),
      'packages/child/src/nested/package.json': stringifyConfig({
        private: true,
      }),
      'packages/package.json': stringifyConfig({ private: true }),
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      'tools/fixture/package.json': stringifyConfig({ private: true }),
    });

    try {
      const rootPackage = createWorkspacePackageFixture(fixture.rootDir, '.', {
        name: 'root',
        private: true,
      });
      const childPackage = createWorkspacePackageFixture(
        fixture.rootDir,
        'packages/child',
        { name: '@example/child', private: true },
      );
      const topology = await collectWorkspaceRegionTopology(
        {
          ...fixture.config,
          regions: {
            exclude: [
              {
                include: ['.'],
                kind: 'workspace-package',
                reason: 'Root tooling is checked separately.',
              },
            ],
          },
        },
        {
          provider: async () => [],
          rawPackages: [rootPackage, childPackage],
        },
      );
      const pathIndex = new WorkspaceRegionPathIndex(
        topology as ValidatedWorkspaceContext,
      );

      expect(
        topology.packages.map((workspacePackage) => workspacePackage.name),
      ).toEqual(['@example/child']);
      expect(topology.boundaries).toEqual([
        expect.objectContaining({
          excluded: false,
          kind: 'package-scope',
          rootDir: fixture.path('packages/child/src/nested'),
        }),
      ]);
      expect(
        pathIndex.isInsideActivatedRegion(
          path.join(fixture.rootDir, 'scripts/release.ts'),
        ),
      ).toBe(false);
      expect(
        pathIndex.isInsideActivatedRegion(
          path.join(fixture.rootDir, 'packages/child/src/index.ts'),
        ),
      ).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not list a nested workspace while discovering the parent island', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({ name: 'root', private: true }),
      'packages/a/fixture/pnpm-workspace.yaml': 'packages: []\n',
      'packages/a/package.json': stringifyConfig({
        name: '@example/a',
        private: true,
      }),
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    });

    try {
      const provider = vi.fn(async () => {
        throw new Error('pnpm list unavailable');
      });
      const topology = await collectWorkspaceRegionTopology(fixture.config, {
        provider,
        rawPackages: [
          createWorkspacePackageFixture(fixture.rootDir, 'packages/a', {
            name: '@example/a',
            private: true,
          }),
        ],
      });

      expect(provider).not.toHaveBeenCalled();
      expect(topology.boundaries).toEqual([
        expect.objectContaining({
          inspection: {
            reason: 'Nested workspace context is discovered independently.',
            status: 'excluded',
          },
          kind: 'pnpm-workspace',
          rootDir: fixture.path('packages/a/fixture'),
        }),
      ]);
    } finally {
      await fixture.cleanup();
    }
  });
});
