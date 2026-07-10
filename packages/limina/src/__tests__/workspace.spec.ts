import type { ResolvedLiminaConfig } from '#config/runner';
import { createLiminaCore } from '#core';
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
import { describe, expect, it } from 'vitest';
import {
  collectWorkspaceRegionBoundaries,
  collectWorkspaceRegionTopology,
  createWorkspaceRegionBoundaryIndex,
} from '../core/workspace/regions';
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

  it('removes excluded exact-overlap packages from current-region package authority', async () => {
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
            reason: 'Nested app workspace is checked separately.',
          },
        ],
      };

      const core = createLiminaCore(fixture.config);
      const rawPackages = await core.workspace.getRawPackages();
      const currentPackages = await core.workspace.getPackages();
      const declarations =
        await core.workspace.getWorkspaceDependencyDeclarations();

      expect(
        rawPackages.map((workspacePackage) => workspacePackage.name),
      ).toEqual(expect.arrayContaining(['@example/app']));
      expect(
        currentPackages.map((workspacePackage) => workspacePackage.name),
      ).not.toContain('@example/app');
      await expect(
        core.workspace.findPackageBySpecifier('@example/app'),
      ).resolves.toBeNull();
      expect(
        declarations.map((declaration) => declaration.dependencyName),
      ).not.toContain('@example/app');
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('collectWorkspaceRegionBoundaries', () => {
  it('discovers nested pnpm workspaces and applies explicit exclusions', async () => {
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
        {
          ...fixture.config,
          regions: {
            exclude: [
              {
                include: ['packages/a/fixture/**'],
                reason: 'Fixture workspace.',
              },
            ],
          },
        },
        collectRawWorkspacePackages,
      );

      expect(
        boundaries.map((boundary) => ({
          excluded: boundary.excluded,
          reason: boundary.exclusionReason,
          root: toPortableRelativePath(fixture.rootDir, boundary.rootDir),
        })),
      ).toEqual([
        {
          excluded: true,
          reason: 'Fixture workspace.',
          root: 'packages/a/fixture',
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores nested pnpm workspace manifests rejected by pnpm validation', async () => {
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
      ).resolves.toEqual([]);
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

  it('does not extend a manifest claimed by any discovered workspace', async () => {
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
      const topology = await collectWorkspaceRegionTopology(
        {
          ...fixture.config,
          regions: {
            extendNestedPackageScopes: true,
          },
        },
        {
          provider: async (config) =>
            config.rootDir === fixture.path('tools') ? [claimedPackage] : [],
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
      ).toBe(true);
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
      ).rejects.toThrow(/does not match a recognized governance unit/u);
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
                reason: 'Nested fixture scope is not part of this run.',
              },
              {
                include: ['packages/a/src/nested/package.json'],
                reason: 'Later matching reasons must not replace the first.',
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

      expect(topology.extendedPackageScopes).toHaveLength(1);
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

  it('propagates an excluded boundary to recognized descendant boundaries', async () => {
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

      expect(topology.boundaries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            excluded: true,
            exclusionReason: 'Nested fixtures are checked separately.',
            kind: 'package-scope',
            rootDir: fixture.path('packages/a/src/nested'),
          }),
          expect.objectContaining({
            excluded: true,
            exclusionReason: 'Nested fixtures are checked separately.',
            kind: 'pnpm-workspace',
            rootDir: fixture.path('packages/a/src/nested/fixture'),
          }),
        ]),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('records an excluded package boundary without hiding a nested active package', async () => {
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
      const boundaryIndex = createWorkspaceRegionBoundaryIndex(
        topology.boundaries,
        topology.packages,
      );

      expect(
        topology.packages.map((workspacePackage) => workspacePackage.name),
      ).toEqual(['@example/a', '@example/child']);
      expect(topology.boundaries).toEqual([
        expect.objectContaining({
          allowWorkspacePackageReentry: true,
          excluded: true,
          exclusionReason: 'Fixture container is an accepted package boundary.',
          rootDir: fixture.path('packages/a/fixtures'),
        }),
      ]);
      expect(
        boundaryIndex.isInsideBoundary(
          path.join(fixture.rootDir, 'packages/a/fixtures/child/src/index.ts'),
        ),
      ).toBe(false);
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
                include: ['package.json'],
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
      const boundaryIndex = createWorkspaceRegionBoundaryIndex(
        topology.boundaries,
        topology.packages,
      );

      expect(
        topology.packages.map((workspacePackage) => workspacePackage.name),
      ).toEqual(['@example/child']);
      expect(topology.boundaries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            allowWorkspacePackageReentry: true,
            excluded: true,
            exclusionReason: 'Root tooling is checked separately.',
            rootDir: fixture.path(),
          }),
          expect.objectContaining({
            excluded: true,
            exclusionReason: 'Root tooling is checked separately.',
            rootDir: fixture.path('tools/fixture'),
          }),
          expect.objectContaining({
            excluded: false,
            rootDir: fixture.path('packages/child/src/nested'),
          }),
          expect.objectContaining({
            allowWorkspacePackageReentry: true,
            excluded: true,
            exclusionReason: 'Root tooling is checked separately.',
            rootDir: fixture.path('packages'),
          }),
        ]),
      );
      expect(
        boundaryIndex.isInsideBoundary(
          path.join(fixture.rootDir, 'scripts/release.ts'),
        ),
      ).toBe(true);
      expect(
        boundaryIndex.isInsideBoundary(
          path.join(fixture.rootDir, 'packages/child/src/index.ts'),
        ),
      ).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('terminates topology discovery when a nested workspace cannot be listed', async () => {
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
      await expect(
        collectWorkspaceRegionTopology(fixture.config, {
          provider: async () => {
            throw new Error('pnpm list unavailable');
          },
          rawPackages: [
            createWorkspacePackageFixture(fixture.rootDir, 'packages/a', {
              name: '@example/a',
              private: true,
            }),
          ],
        }),
      ).rejects.toThrow(
        /Failed to inspect nested pnpm workspace region[\s\S]*pnpm list unavailable/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
