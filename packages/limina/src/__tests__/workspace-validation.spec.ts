import type { ResolvedLiminaConfig } from '#config/runner';
import type { WorkspacePackage } from '#core/workspace/actions';
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
import {
  collectValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../core/workspace/validated-context';
import { createProfilingMetricsRecorder } from '../profiling/metrics';
import {
  createFixturePathResolver,
  toPortableRelativePath,
} from './helpers/path';

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeText(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

async function createFixture(files: Record<string, string> = {}): Promise<{
  cleanup: () => Promise<void>;
  config: ResolvedLiminaConfig;
  path: (...segments: string[]) => string;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-workspace-validation-')),
  );
  const fixturePath = createFixturePathResolver(rootDir);
  const allFiles = {
    'limina.config.mjs': 'export default {};\n',
    'package.json': json({ name: 'fixture-root', private: true }),
    'pnpm-workspace.yaml': 'packages: []\n',
    ...files,
  };
  for (const [relativePath, content] of Object.entries(allFiles)) {
    await writeText(fixturePath(relativePath), content);
  }

  return {
    cleanup: () => rm(rootDir, { force: true, recursive: true }),
    config: {
      configPath: fixturePath('limina.config.mjs'),
      rootDir,
    },
    path: fixturePath,
    rootDir,
  };
}

function workspacePackage(directory: string, name: string): WorkspacePackage {
  return {
    directory,
    manifest: { name, private: true },
    name,
  };
}

describe('validated workspace context', () => {
  it('blocks lexical package aliases with the same canonical identity', async () => {
    const fixture = await createFixture({
      'packages/real/package.json': json({
        name: '@fixture/real',
        private: true,
      }),
    });
    await symlink(
      fixture.path('packages/real'),
      fixture.path('packages/alias'),
    );

    try {
      await expect(
        collectValidatedWorkspaceContext({
          config: fixture.config,
          rawPackages: [
            workspacePackage(fixture.path('packages/real'), '@fixture/real'),
            workspacePackage(fixture.path('packages/alias'), '@fixture/alias'),
          ],
        }),
      ).rejects.toMatchObject({
        issues: [
          expect.objectContaining({
            code: 'LIMINA_WORKSPACE_PACKAGE_IDENTITY_CONFLICT',
            filePath: 'packages/real/package.json',
          }),
        ],
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('validates canonical identity after lexical package exclusion', async () => {
    const fixture = await createFixture({
      'packages/real/package.json': json({
        name: '@fixture/real',
        private: true,
      }),
    });
    await symlink(
      fixture.path('packages/real'),
      fixture.path('packages/alias'),
    );
    fixture.config.regions = {
      exclude: [
        {
          include: ['packages/alias'],
          kind: 'workspace-package',
          reason: 'The alias is not a separate package owner.',
        },
      ],
    };

    try {
      const context = await collectValidatedWorkspaceContext({
        config: fixture.config,
        rawPackages: [
          workspacePackage(fixture.path('packages/real'), '@fixture/real'),
          workspacePackage(fixture.path('packages/alias'), '@fixture/alias'),
        ],
      });

      expect(context.rawPackages).toHaveLength(2);
      expect(
        context.packages.map((workspacePackage) => workspacePackage.name),
      ).toEqual(['@fixture/real']);
      expect(context.packageIdentities).toEqual([
        expect.objectContaining({ displayDirectory: 'packages/real' }),
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps config-relative parent selectors for external package exclusions', async () => {
    const fixture = await createFixture();
    const externalRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-external-package-')),
    );
    await writeText(
      path.join(externalRoot, 'package.json'),
      json({ name: '@fixture/external', private: true }),
    );
    fixture.config.regions = {
      exclude: [
        {
          include: [toPortableRelativePath(fixture.rootDir, externalRoot)],
          kind: 'workspace-package',
          reason: 'The external package is checked separately.',
        },
      ],
    };

    try {
      const context = await collectValidatedWorkspaceContext({
        config: fixture.config,
        rawPackages: [workspacePackage(externalRoot, '@fixture/external')],
      });

      expect(context.rawPackages).toHaveLength(1);
      expect(context.packages).toEqual([]);
    } finally {
      await Promise.all([
        fixture.cleanup(),
        rm(externalRoot, { force: true, recursive: true }),
      ]);
    }
  });

  it('uses canonical identity for owner lookup while preserving lexical package display', async () => {
    const fixture = await createFixture();
    const physicalRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-physical-package-')),
    );
    await writeText(
      path.join(physicalRoot, 'package.json'),
      json({ name: '@fixture/external', private: true }),
    );
    await writeText(path.join(physicalRoot, 'src/index.ts'), 'export {};\n');
    await mkdir(fixture.path('packages'), { recursive: true });
    await symlink(physicalRoot, fixture.path('packages/external'));

    try {
      const context = await collectValidatedWorkspaceContext({
        config: fixture.config,
        rawPackages: [
          workspacePackage(
            fixture.path('packages/external'),
            '@fixture/external',
          ),
        ],
      });
      const pathIndex = new WorkspaceRegionPathIndex(context);

      expect(context.packageIdentities[0]?.displayDirectory).toBe(
        'packages/external',
      );
      expect(
        pathIndex.findPackageForPath(path.join(physicalRoot, 'src/index.ts'))
          ?.name,
      ).toBe('@fixture/external');
    } finally {
      await Promise.all([
        fixture.cleanup(),
        rm(physicalRoot, { force: true, recursive: true }),
      ]);
    }
  });

  it('memoizes projected canonical paths and positive and negative region lookups', async () => {
    const fixture = await createFixture({
      'packages/app/package.json': json({
        name: '@fixture/app',
        private: true,
      }),
    });

    try {
      const context = await collectValidatedWorkspaceContext({
        config: fixture.config,
        rawPackages: [
          workspacePackage(fixture.path('packages/app'), '@fixture/app'),
        ],
      });
      const metrics = createProfilingMetricsRecorder();
      const pathIndex = new WorkspaceRegionPathIndex(context, metrics);
      const packageFile = fixture.path('packages/app/src/index.ts');
      const outsideFile = path.join(fixture.rootDir, '..', 'outside.ts');

      expect(pathIndex.findPackageForPath(packageFile)?.name).toBe(
        '@fixture/app',
      );
      expect(pathIndex.findBoundaryForPath(packageFile)).toBeNull();
      expect(pathIndex.findPackageForPath(packageFile)?.name).toBe(
        '@fixture/app',
      );
      expect(pathIndex.findBoundaryForPath(packageFile)).toBeNull();
      expect(pathIndex.findPackageForPath(outsideFile)).toBeNull();
      expect(pathIndex.findPackageForPath(outsideFile)).toBeNull();

      const snapshot = metrics.snapshot();
      const metricCount = (name: string, kind?: string): number =>
        snapshot.find(
          (metric) =>
            metric.name === name &&
            (kind === undefined || metric.kind === kind),
        )?.count ?? 0;

      expect(metricCount('canonical-path')).toBe(
        metricCount('canonical-path-cache-miss'),
      );
      expect(metricCount('canonical-path-cache-hit')).toBe(0);
      expect(
        metricCount('provider-cache-hit', 'package-boundary'),
      ).toBeGreaterThan(0);
      expect(metricCount('provider-cache-miss', 'package-boundary')).toBe(2);
      expect(metricCount('workspace-negative-lookup')).toBeGreaterThan(0);
      expect(
        metricCount('workspace-path-classification-miss', 'package-boundary'),
      ).toBe(2);
      expect(
        metricCount('workspace-path-classification-hit', 'package-boundary'),
      ).toBe(4);
      expect(metricCount('workspace-path-ancestor-visit')).toBeGreaterThan(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    ['config root', '.'],
    ['config ancestor', '..'],
    ['internal namespace', '.limina'],
    ['activated package root', 'packages/app'],
    ['activated package ancestor', 'packages'],
  ])('rejects a package output rooted at the %s', async (_label, outDir) => {
    const fixture = await createFixture({
      'packages/app/package.json': json({
        name: '@fixture/app',
        private: true,
      }),
    });
    fixture.config.package = {
      entries: [{ checks: [], name: '@fixture/output', outDir }],
    };

    try {
      await expect(
        collectValidatedWorkspaceContext({
          config: fixture.config,
          rawPackages: [
            workspacePackage(fixture.path('packages/app'), '@fixture/app'),
          ],
        }),
      ).rejects.toMatchObject({
        issues: [
          expect.objectContaining({
            code: 'LIMINA_WORKSPACE_OUTPUT_ROOT_INVALID',
            task: 'workspace:validate',
          }),
        ],
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(['packages/app/dist', '../shared/dist'])(
    'accepts a dedicated package artifact output at %s',
    async (outDir) => {
      const fixture = await createFixture({
        'packages/app/package.json': json({
          name: '@fixture/app',
          private: true,
        }),
      });
      fixture.config.package = {
        entries: [{ checks: [], name: '@fixture/output', outDir }],
      };

      try {
        const context = await collectValidatedWorkspaceContext({
          config: fixture.config,
          rawPackages: [
            workspacePackage(fixture.path('packages/app'), '@fixture/app'),
          ],
        });

        expect(context.outputRoots).toEqual([fixture.path(outDir)]);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('allows an output at an excluded overlap boundary without an active descendant', async () => {
    const fixture = await createFixture({
      'packages/parent/fixture/package.json': json({
        name: '@fixture/fixture',
        private: true,
      }),
      'packages/parent/fixture/pnpm-workspace.yaml': 'packages: []\n',
      'packages/parent/package.json': json({
        name: '@fixture/parent',
        private: true,
      }),
    });
    fixture.config.package = {
      entries: [
        {
          checks: [],
          name: '@fixture/output',
          outDir: 'packages/parent/fixture',
        },
      ],
    };
    fixture.config.regions = {
      exclude: [
        {
          include: ['packages/parent/fixture'],
          kind: 'workspace-package',
          reason: 'The nested workspace is checked separately.',
        },
      ],
    };

    try {
      const context = await collectValidatedWorkspaceContext({
        config: fixture.config,
        rawPackages: [
          workspacePackage(fixture.path('packages/parent'), '@fixture/parent'),
          workspacePackage(
            fixture.path('packages/parent/fixture'),
            '@fixture/fixture',
          ),
        ],
      });

      expect(
        context.packages.map((workspacePackage) => workspacePackage.name),
      ).toEqual(['@fixture/parent']);
      expect(context.outputRoots).toEqual([
        fixture.path('packages/parent/fixture'),
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects an output containing an active descendant of an excluded overlap', async () => {
    const fixture = await createFixture({
      'packages/parent/fixture/nested/package.json': json({
        name: '@fixture/nested',
        private: true,
      }),
      'packages/parent/fixture/package.json': json({
        name: '@fixture/fixture',
        private: true,
      }),
      'packages/parent/fixture/pnpm-workspace.yaml': 'packages: []\n',
      'packages/parent/package.json': json({
        name: '@fixture/parent',
        private: true,
      }),
    });
    fixture.config.package = {
      entries: [
        {
          checks: [],
          name: '@fixture/output',
          outDir: 'packages/parent/fixture',
        },
      ],
    };
    fixture.config.regions = {
      exclude: [
        {
          include: ['packages/parent/fixture'],
          kind: 'workspace-package',
          reason: 'The nested workspace is checked separately.',
        },
      ],
    };

    try {
      await expect(
        collectValidatedWorkspaceContext({
          config: fixture.config,
          rawPackages: [
            workspacePackage(
              fixture.path('packages/parent'),
              '@fixture/parent',
            ),
            workspacePackage(
              fixture.path('packages/parent/fixture'),
              '@fixture/fixture',
            ),
            workspacePackage(
              fixture.path('packages/parent/fixture/nested'),
              '@fixture/nested',
            ),
          ],
        }),
      ).rejects.toMatchObject({
        issues: [
          expect.objectContaining({
            code: 'LIMINA_WORKSPACE_OUTPUT_ROOT_INVALID',
            reason:
              'The output root equals or contains an activated package root.',
          }),
        ],
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('never reads tsconfig output declarations behind a nested workspace boundary', async () => {
    const fixture = await createFixture({
      'packages/app/fixture/pnpm-workspace.yaml': 'packages: []\n',
      'packages/app/fixture/tsconfig.json': json({
        liminaOptions: { outputs: { outDir: '../../..' } },
      }),
      'packages/app/package.json': json({
        name: '@fixture/app',
        private: true,
      }),
    });

    try {
      const context = await collectValidatedWorkspaceContext({
        config: fixture.config,
        rawPackages: [
          workspacePackage(fixture.path('packages/app'), '@fixture/app'),
        ],
      });

      expect(context.sourceConfigPaths).toEqual([]);
      expect(context.boundaries).toEqual([
        expect.objectContaining({
          kind: 'pnpm-workspace',
          rootDir: fixture.path('packages/app/fixture'),
        }),
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('never reads tsconfig output declarations inside unconditional package output', async () => {
    const fixture = await createFixture({
      'packages/app/generated/tsconfig.json': json({
        liminaOptions: { outputs: { outDir: '../../..' } },
      }),
      'packages/app/package.json': json({
        name: '@fixture/app',
        private: true,
      }),
    });
    fixture.config.package = {
      entries: [
        {
          checks: [],
          name: '@fixture/output',
          outDir: 'packages/app/generated',
        },
      ],
    };

    try {
      const context = await collectValidatedWorkspaceContext({
        config: fixture.config,
        rawPackages: [
          workspacePackage(fixture.path('packages/app'), '@fixture/app'),
        ],
      });

      expect(context.sourceConfigPaths).toEqual([]);
      expect(context.outputRoots).toEqual([
        fixture.path('packages/app/generated'),
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('filters output descriptors by canonical identity across a symlink alias', async () => {
    const fixture = await createFixture();
    const physicalRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-output-physical-package-')),
    );
    const physicalPath = createFixturePathResolver(physicalRoot);
    await writeText(
      path.join(physicalRoot, 'package.json'),
      json({ name: '@fixture/external', private: true }),
    );
    await writeText(
      path.join(physicalRoot, 'generated/tsconfig.json'),
      json({ compilerOptions: { noEmit: true } }),
    );
    await symlink(physicalRoot, fixture.path('alias'));
    fixture.config.package = {
      entries: [
        {
          checks: [],
          name: '@fixture/output',
          outDir: 'alias/generated',
        },
      ],
    };

    try {
      const context = await collectValidatedWorkspaceContext({
        config: fixture.config,
        rawPackages: [workspacePackage(physicalRoot, '@fixture/external')],
      });

      expect(context.outputRoots).toEqual([fixture.path('alias/generated')]);
      expect(context.sourceConfigPaths).toEqual([]);
      expect(context.descriptorCandidates).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: physicalPath('generated/tsconfig.json'),
          }),
        ]),
      );
    } finally {
      await Promise.all([
        fixture.cleanup(),
        rm(physicalRoot, { force: true, recursive: true }),
      ]);
    }
  });

  it('applies cross-island outputs in one workspace-global fixed point', async () => {
    const fixture = await createFixture({
      'packages/a/package.json': json({ name: '@fixture/a', private: true }),
      'packages/a/tsconfig.json': json({
        liminaOptions: { outputs: { outDir: '../b/generated' } },
      }),
      'packages/b/generated/pnpm-workspace.yaml': 'packages: []\n',
      'packages/b/package.json': json({ name: '@fixture/b', private: true }),
    });

    try {
      const context = await collectValidatedWorkspaceContext({
        config: fixture.config,
        rawPackages: [
          workspacePackage(fixture.path('packages/a'), '@fixture/a'),
          workspacePackage(fixture.path('packages/b'), '@fixture/b'),
        ],
      });

      expect(context.outputRoots).toEqual([
        fixture.path('packages/b/generated'),
      ]);
      expect(context.sourceConfigPaths).toEqual([
        fixture.path('packages/a/tsconfig.json'),
      ]);
      expect(context.descriptorCandidates).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: fixture.path('packages/b/generated/pnpm-workspace.yaml'),
          }),
        ]),
      );
      expect(context.boundaries).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports a self-output visibility cycle', async () => {
    const fixture = await createFixture({
      'packages/app/config/tsconfig.json': json({
        liminaOptions: { outputs: { outDir: '.' } },
      }),
      'packages/app/package.json': json({
        name: '@fixture/app',
        private: true,
      }),
    });

    try {
      await expect(
        collectValidatedWorkspaceContext({
          config: fixture.config,
          rawPackages: [
            workspacePackage(fixture.path('packages/app'), '@fixture/app'),
          ],
        }),
      ).rejects.toMatchObject({
        issues: [
          expect.objectContaining({
            code: 'LIMINA_WORKSPACE_OUTPUT_CYCLE',
          }),
        ],
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports a mutual-output visibility cycle', async () => {
    const fixture = await createFixture({
      'packages/app/a/tsconfig.json': json({
        liminaOptions: { outputs: { outDir: '../b' } },
      }),
      'packages/app/b/tsconfig.json': json({
        liminaOptions: { outputs: { outDir: '../a' } },
      }),
      'packages/app/package.json': json({
        name: '@fixture/app',
        private: true,
      }),
    });

    try {
      await expect(
        collectValidatedWorkspaceContext({
          config: fixture.config,
          rawPackages: [
            workspacePackage(fixture.path('packages/app'), '@fixture/app'),
          ],
        }),
      ).rejects.toMatchObject({
        issues: [
          expect.objectContaining({
            code: 'LIMINA_WORKSPACE_OUTPUT_CYCLE',
          }),
        ],
      });
    } finally {
      await fixture.cleanup();
    }
  });
});
