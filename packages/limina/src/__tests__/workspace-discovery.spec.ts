import {
  collectRawWorkspacePackages,
  collectWorkspacePackages,
} from '#core/workspace/actions';
import {
  resolveGovernanceRoot,
  type SupportedPackageManager,
} from '#utils/workspace-root';
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
import { afterEach, describe, expect, it } from 'vitest';
import { locateCheckIssueWorkspace } from '../check-reporting/workspace-locator';
import { loadConfig } from '../config/loader';
import {
  collectValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../core/workspace/validated-context';
import { resolveFixtureGovernanceRoot } from './helpers/governance-root';
import {
  createFixturePathResolver,
  toPortableRelativePaths,
} from './helpers/path';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const json = (value: unknown) => JSON.stringify(value);
async function fixture(files: Record<string, string>) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-discovery-')),
  );
  roots.push(root);
  const resolve = createFixturePathResolver(root);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(resolve(file)), { recursive: true });
    await writeFile(resolve(file), text);
  }
  return {
    path: resolve,
    config: {
      get governanceRoot() {
        return resolveFixtureGovernanceRoot(this);
      },
      rootDir: resolve(),
      configPath: resolve('limina.config.mjs'),
    },
  };
}
function declaration(
  manager: SupportedPackageManager,
  globs: unknown = ['packages/*'],
) {
  return {
    'package.json': json({
      name: 'root',
      packageManager: `${manager}@test-version`,
      workspaces: globs,
    }),
    ...(manager === 'pnpm'
      ? { 'pnpm-workspace.yaml': `packages: ${json(globs)}\n` }
      : {}),
  };
}
const managers = ['pnpm', 'npm', 'yarn', 'bun'] as const;

describe('workspace root authority', () => {
  it.each(managers)(
    'keeps child single-package governance inside an outer %s workspace',
    async (manager) => {
      const f = await fixture({
        ...declaration(manager),
        'packages/a/package.json': '{}',
        'packages/a/src/a.ts': '',
      });
      expect(
        resolveGovernanceRoot(f.path('packages/a/src/limina.config.mjs')),
      ).toMatchObject({
        rootDir: f.path('packages/a'),
        kind: 'single-package',
      });
    },
  );
  it('selects a nearer npm descriptor before an outer pnpm descriptor', async () => {
    const f = await fixture({
      'pnpm-workspace.yaml': 'packages: []',
      'inner/package.json': json({ workspaces: [] }),
      'inner/package-lock.json': '',
    });
    expect(
      resolveGovernanceRoot(f.path('inner/limina.config.mjs')),
    ).toMatchObject({
      rootDir: f.path('inner'),
      packageManager: 'npm',
    });
  });
  it('gives a same-directory pnpm descriptor authority over unused workspaces and lockfiles', async () => {
    const f = await fixture({
      'pnpm-workspace.yaml': 'packages: []',
      'package.json': json({ workspaces: 42 }),
      'yarn.lock': '',
      'bun.lock': '',
    });
    expect(resolveGovernanceRoot(f.path('limina.config.mjs'))).toHaveProperty(
      'packageManager',
      'pnpm',
    );
  });
  it.each(['npm', 'yarn', 'bun'])(
    'rejects pnpm descriptor with explicit %s identity',
    async (manager) => {
      const f = await fixture({
        ...declaration('pnpm'),
        'package.json': json({ packageManager: `${manager}@1` }),
      });
      expect(() => resolveGovernanceRoot(f.path('limina.config.mjs'))).toThrow(
        /Conflicting package manager/u,
      );
    },
  );
  it.each([
    [123, /Invalid packageManager/u],
    ['', /Invalid packageManager/u],
    ['npm', /Invalid packageManager/u],
    ['npm@', /Invalid packageManager/u],
    ['deno@2', /Unsupported package manager/u],
    [null, /Invalid packageManager/u],
  ])('rejects uninterpretable identity %s', async (value, error) => {
    const f = await fixture({
      'package.json': json({ packageManager: value, workspaces: [] }),
    });
    expect(() => resolveGovernanceRoot(f.path('limina.config.mjs'))).toThrow(
      error as RegExp,
    );
  });
  it.each([
    [['package-lock.json'], 'npm'],
    [['npm-shrinkwrap.json'], 'npm'],
    [['package-lock.json', 'npm-shrinkwrap.json'], 'npm'],
    [['yarn.lock'], 'yarn'],
    [['bun.lock'], 'bun'],
    [['bun.lockb'], 'bun'],
    [['bun.lock', 'bun.lockb'], 'bun'],
  ] as const)(
    'infers deduplicated same-root locks %s',
    async (files, manager) => {
      const f = await fixture({
        'package.json': json({ workspaces: [] }),
        ...Object.fromEntries(files.map((file) => [file, ''])),
      });
      expect(resolveGovernanceRoot(f.path('limina.config.mjs'))).toHaveProperty(
        'packageManager',
        manager,
      );
    },
  );
  it.each([
    [[], /undetermined/u],
    [['pnpm-lock.yaml'], /pnpm-workspace.yaml missing/u],
    [['pnpm-lock.yaml', 'package-lock.json'], /Ambiguous/u],
    [['bun.lock', 'yarn.lock'], /Ambiguous/u],
  ] as const)(
    'fails closed for incomplete or ambiguous identity %s',
    async (files, error) => {
      const f = await fixture({
        'package.json': json({ workspaces: [] }),
        ...Object.fromEntries(files.map((file) => [file, ''])),
      });
      expect(() => resolveGovernanceRoot(f.path('limina.config.mjs'))).toThrow(
        error,
      );
    },
  );
  it('never inherits lockfiles from ancestors or lets locks override explicit identity', async () => {
    const f = await fixture({
      'yarn.lock': '',
      'inner/package.json': json({ workspaces: [] }),
    });
    expect(() =>
      resolveGovernanceRoot(f.path('inner/limina.config.mjs')),
    ).toThrow(/undetermined/u);
    await writeFile(
      f.path('inner/package.json'),
      json({ workspaces: [], packageManager: 'yarn@any' }),
    );
    for (const name of ['package-lock.json', 'pnpm-lock.yaml', 'bun.lock'])
      await writeFile(f.path('inner', name), '');
    expect(
      resolveGovernanceRoot(f.path('inner/limina.config.mjs')),
    ).toHaveProperty('packageManager', 'yarn');
  });
  it('requires a pnpm descriptor only when workspace semantics are declared', async () => {
    const f = await fixture({
      'package.json': json({ workspaces: [], packageManager: 'pnpm@1' }),
    });
    expect(() => resolveGovernanceRoot(f.path('limina.config.mjs'))).toThrow(
      /pnpm-workspace.yaml missing/u,
    );
    await writeFile(f.path('package.json'), '{}');
    expect(resolveGovernanceRoot(f.path('limina.config.mjs'))).toMatchObject({
      kind: 'single-package',
    });
  });
  it('does not skip a malformed nearer manifest', async () => {
    const f = await fixture({
      'pnpm-workspace.yaml': 'packages: []',
      'inner/package.json': '{',
    });
    expect(() =>
      resolveGovernanceRoot(f.path('inner/limina.config.mjs')),
    ).toThrow(f.path('inner/package.json'));
  });
});

describe('manager declaration and package selection', () => {
  it.each(managers)(
    '%s preserves nameless packages, root inclusion, and missing-manifest skips',
    async (manager) => {
      const f = await fixture({
        ...declaration(manager, ['./packages/*/', '.', '../shared/*']),
        'packages/a/package.json': '{}',
        'packages/empty/file.ts': '',
        'shared/package.json': '{}',
      });
      const packages = await collectRawWorkspacePackages(f.config);
      expect(packages.map((p) => p.name)).toEqual(['root', undefined]);
      expect(
        toPortableRelativePaths(
          f.path(),
          packages.map((p) => p.directory),
        ),
      ).toEqual(['', 'packages/a']);
    },
  );
  it.each(['yarn', 'bun'] as const)(
    'accepts %s object projection without validating unrelated fields',
    async (manager) => {
      const f = await fixture(
        declaration(manager, { packages: [], catalog: 42 }),
      );
      await expect(collectRawWorkspacePackages(f.config)).resolves.toHaveLength(
        1,
      );
    },
  );
  it('rejects npm object form as outside the supported Limina projection', async () => {
    const f = await fixture(declaration('npm', { packages: [] }));
    await expect(collectRawWorkspacePackages(f.config)).rejects.toThrow(
      /Invalid npm workspace declaration/u,
    );
  });
  it.each(managers)('rejects invalid %s glob arrays', async (manager) => {
    const f = await fixture(declaration(manager, ['packages/*', 1]));
    await expect(collectRawWorkspacePackages(f.config)).rejects.toThrow(
      /workspace declaration/u,
    );
  });
  it('pnpm accepts absent packages and unrelated invalid catalog shape, but rejects YAML syntax', async () => {
    const f = await fixture({
      'package.json': '{}',
      'pnpm-workspace.yaml': 'catalogs: []\n',
    });
    await expect(collectRawWorkspacePackages(f.config)).resolves.toHaveLength(
      1,
    );
    await writeFile(f.path('pnpm-workspace.yaml'), 'packages: [');
    await expect(collectRawWorkspacePackages(f.config)).rejects.toThrow();
  });
  it.each(managers)(
    '%s fails on malformed matched manifests',
    async (manager) => {
      const f = await fixture({
        ...declaration(manager),
        'packages/a/package.json': '{',
      });
      await expect(collectRawWorkspacePackages(f.config)).rejects.toThrow(
        SyntaxError,
      );
    },
  );
  it.each(managers)(
    '%s applies only its own traversal ignores',
    async (manager) => {
      const directories = [
        'node_modules/x',
        'bower_components/x',
        '.git/x',
        '.yarn/x',
        'CMakeFiles/x',
        'normal/x',
        'test/x',
        'tests/x',
      ];
      const f = await fixture({
        ...declaration(manager, ['**', '.git/x', '.yarn/x']),
        ...Object.fromEntries(
          directories.map((dir) => [`${dir}/package.json`, '{}']),
        ),
      });
      const ignored = {
        pnpm: ['node_modules', 'bower_components'],
        npm: ['node_modules'],
        yarn: ['node_modules', '.git', '.yarn'],
        bun: ['node_modules', '.git', 'CMakeFiles'],
      }[manager];
      const packages = await collectRawWorkspacePackages(f.config);
      expect(
        toPortableRelativePaths(
          f.path(),
          packages.map((p) => p.directory),
        ).sort(),
      ).toEqual(
        [
          '',
          ...directories.filter((dir) => !ignored.includes(dir.split('/')[0]!)),
        ].sort(),
      );
    },
  );
  it.each([
    ['pnpm', ['packages/a']],
    ['yarn', ['packages/a']],
    ['npm', ['packages/a', 'packages/b', 'packages/b/c']],
    ['bun', ['packages/a', 'packages/b', 'packages/b/c']],
  ] as const)(
    '%s preserves its re-inclusion semantics',
    async (manager, expected) => {
      const f = await fixture({
        ...declaration(manager, [
          'packages/**',
          '!packages/b/**',
          'packages/b/c',
        ]),
        'packages/a/package.json': '{}',
        'packages/b/package.json': '{}',
        'packages/b/c/package.json': '{}',
      });
      const packages = await collectRawWorkspacePackages(f.config);
      expect(
        toPortableRelativePaths(
          f.path(),
          packages.map((p) => p.directory),
        ),
      ).toEqual(['', ...expected]);
    },
  );
  it('Bun trailing globstar exclusion preserves the directory itself', async () => {
    const f = await fixture({
      ...declaration('bun', ['packages/**', '!packages/b/**']),
      'packages/b/package.json': '{}',
      'packages/b/c/package.json': '{}',
    });
    expect(
      toPortableRelativePaths(
        f.path(),
        (await collectRawWorkspacePackages(f.config)).map((p) => p.directory),
      ),
    ).toEqual(['', 'packages/b']);
  });
  it('retains symlink aliases including ancestor cycles without recursing through them', async () => {
    const f = await fixture({
      ...declaration('pnpm', ['packages/**']),
      'external/a/package.json': '{}',
    });
    await mkdir(f.path('packages'));
    await symlink(f.path('external/a'), f.path('packages/alias'), 'junction');
    await symlink(f.path('external/a'), f.path('external/a/loop'), 'junction');
    expect(
      toPortableRelativePaths(
        f.path(),
        (await collectRawWorkspacePackages(f.config)).map((p) => p.directory),
      ),
    ).toEqual(['', 'packages/alias', 'packages/alias/loop']);
    await expect(collectWorkspacePackages(f.config)).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'LIMINA_WORKSPACE_PACKAGE_IDENTITY_CONFLICT',
        }),
      ]),
    });
  });
  it.each(['pnpm', 'npm', 'bun'] as const)(
    '%s exact negation retains unmatched descendant packages',
    async (manager) => {
      const f = await fixture({
        ...declaration(manager, ['packages/**', '!packages/b']),
        'packages/b/package.json': '{}',
        'packages/b/c/package.json': '{}',
      });
      expect(
        toPortableRelativePaths(
          f.path(),
          (await collectRawWorkspacePackages(f.config)).map((p) => p.directory),
        ),
      ).toEqual(['', 'packages/b/c']);
    },
  );
  it('a broken link does not erase valid sibling directory candidates', async () => {
    const f = await fixture({
      ...declaration('pnpm'),
      'packages/a/package.json': '{}',
    });
    await symlink(f.path('absent'), f.path('packages/broken'), 'junction');
    expect(
      toPortableRelativePaths(
        f.path(),
        (await collectRawWorkspacePackages(f.config)).map((p) => p.directory),
      ),
    ).toEqual(['', 'packages/a']);
  });
  it('retains lexical aliases until physical identity validation rejects them', async () => {
    const f = await fixture({
      ...declaration('npm'),
      'packages/a/package.json': '{}',
    });
    await symlink(f.path('packages/a'), f.path('packages/b'), 'junction');
    const packages = await collectRawWorkspacePackages(f.config);
    expect(
      toPortableRelativePaths(
        f.path(),
        packages.map((p) => p.directory),
      ),
    ).toEqual(['', 'packages/a', 'packages/b']);
    await expect(collectWorkspacePackages(f.config)).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'LIMINA_WORKSPACE_PACKAGE_IDENTITY_CONFLICT',
        }),
      ]),
    });
  });
});

describe('workspace roots across consumers', () => {
  it.each(managers)(
    '%s implicit and explicit config plus issue location share root authority',
    async (manager) => {
      const f = await fixture({
        ...declaration(manager),
        'limina.config.mjs': 'export default {};',
        'packages/a/package.json': '{}',
      });
      const implicit = await loadConfig({ cwd: f.path('packages/a') });
      const explicit = await loadConfig({
        cwd: f.path('packages/a'),
        configPath: '../../limina.config.mjs',
      });
      expect(implicit.rootDir).toBe(f.path());
      expect(explicit.rootDir).toBe(f.path());
      expect(
        locateCheckIssueWorkspace({ cwd: f.path('packages/a/missing') })
          .rootDir,
      ).toBe(f.path());
    },
  );
  it('discovers outer config across a nearer workspace declaration', async () => {
    const f = await fixture({
      'package.json': '{}',
      'pnpm-workspace.yaml': 'packages: []',
      'limina.config.mjs': 'export default {};',
      'inner/package.json': json({ workspaces: [], packageManager: 'npm@1' }),
    });
    expect((await loadConfig({ cwd: f.path('inner') })).rootDir).toBe(f.path());
  });
  it.each(['npm', 'yarn', 'bun', undefined])(
    'nested %s workspace stops nameless extension without manager resolution',
    async (manager) => {
      const f = await fixture({
        ...declaration('pnpm'),
        'packages/a/package.json': '{}',
        'packages/a/nested/package.json': json({
          workspaces: [],
          ...(manager ? { packageManager: `${manager}@1` } : {}),
        }),
        'packages/a/nested/source.ts': '',
        'packages/a/nested/tsconfig.json': '{}',
      });
      const config = {
        ...f.config,
        regions: { extendNestedPackageScopes: true },
      };
      const context = await collectValidatedWorkspaceContext({
        config,
        rawPackages: await collectRawWorkspacePackages(config),
      });
      expect(context.boundaries).toContainEqual(
        expect.objectContaining({
          kind: 'workspace-root',
          descriptor: {
            kind: 'package-json-workspaces',
            path: f.path('packages/a/nested/package.json'),
          },
        }),
      );
      expect(
        new WorkspaceRegionPathIndex(context).classifyPath(
          f.path('packages/a/nested/source.ts'),
        ).package,
      ).toBeNull();
      expect(context.sourceConfigPaths).not.toContain(
        f.path('packages/a/nested/tsconfig.json'),
      );
    },
  );
  it('rejects package.json workspace same-root overlap with the actual descriptor', async () => {
    const f = await fixture({
      ...declaration('pnpm'),
      'packages/a/package.json': json({ workspaces: [] }),
    });
    await expect(collectWorkspacePackages(f.config)).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'LIMINA_WORKSPACE_REGION_OVERLAP' }),
      ]),
    });
  });
  it('does not offer a workspace-root manifest as a package-scope exclusion candidate', async () => {
    const f = await fixture({
      ...declaration('npm'),
      'packages/a/package.json': '{}',
      'packages/a/nested/package.json': json({ workspaces: [] }),
    });
    await expect(
      collectWorkspacePackages({
        ...f.config,
        regions: {
          exclude: [
            {
              kind: 'package-scope',
              include: ['packages/a/nested'],
              reason: 'separate',
            },
          ],
        },
      }),
    ).rejects.toThrow(/does not match an exact governance candidate/u);
  });
});
