import { loadConfig } from '#config/runner';
import {
  collectImporters,
  collectRawWorkspacePackages,
} from '#core/workspace/actions';
import {
  resolveGovernancePackageManager,
  resolveGovernanceRoot,
} from '#utils/workspace-root';
import { mkdir, rename, rm, symlink } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { locateCheckIssueWorkspace } from '../check-reporting/workspace-locator';
import { collectPackageBuildScripts } from '../core/packages/build-scripts';
import { collectWorkspaceDependencyDeclarations } from '../core/packages/dependency-authority';
import { cloneValidatedWorkspaceContext } from '../core/workspace/clones';
import { getPackageOwnerIdentity } from '../core/workspace/owner-identity';
import { collectValidatedWorkspaceContext } from '../core/workspace/validated-context';
import { createSinglePackageFixture } from './helpers/single-package';

const cleanups: (() => Promise<void>)[] = [];
async function fixture(files: Record<string, string> = {}) {
  const result = await createSinglePackageFixture(files);
  cleanups.push(result.cleanup);
  return result;
}
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
const json = JSON.stringify;

describe('config-selected governance root', () => {
  it('changes roots with --config and keeps each root across calling directories', async () => {
    const f = await fixture({
      'package.json': json({
        workspaces: ['packages/*'],
        packageManager: 'npm@1',
      }),
      'packages/a/package.json': '{}',
      'packages/a/limina.config.mjs': 'export default {};',
      'packages/b/package.json': '{}',
      'packages/b/src/index.ts': '',
    });
    for (const cwd of [f.path(), f.path('packages/b/src')]) {
      const root = await f.load(f.path('limina.config.mjs'), cwd);
      const child = await f.load(f.path('packages/a/limina.config.mjs'), cwd);
      expect(root.governanceRoot.kind).toBe('workspace');
      expect(root.rootDir).toBe(f.path());
      expect(await collectRawWorkspacePackages(root)).toHaveLength(3);
      expect(child.governanceRoot.kind).toBe('single-package');
      expect(child.rootDir).toBe(f.path('packages/a'));
      expect(await collectRawWorkspacePackages(child)).toHaveLength(1);
    }
    expect((await loadConfig({ cwd: f.path('packages/b/src') })).rootDir).toBe(
      f.path(),
    );
  });

  it('does not consult an ancestor workspace after selecting the nearest manifest', async () => {
    const f = await fixture({
      'local/package.json': '{}',
      'local/limina.config.mjs': 'export default {};',
    });
    for (const declaration of [
      'packages: [local]',
      'packages: [',
      'packages: []',
    ]) {
      await f.write('pnpm-workspace.yaml', declaration);
      const config = await f.load(f.path('local/limina.config.mjs'));
      expect(config.governanceRoot.kind).toBe('single-package');
      expect(
        (await collectRawWorkspacePackages(config)).map(
          (entry) => entry.directory,
        ),
      ).toEqual([f.path('local')]);
    }
    await rm(f.path('pnpm-workspace.yaml'));
    expect((await f.load(f.path('local/limina.config.mjs'))).rootDir).toBe(
      f.path('local'),
    );
  });

  it.each(['{', 'null', '[]', 'true', '"value"'])(
    'fails at the nearest invalid manifest %s',
    async (contents) => {
      const f = await fixture({
        'local/package.json': contents,
        'local/limina.config.mjs': 'throw new Error("must not import");',
      });
      await expect(f.load(f.path('local/limina.config.mjs'))).rejects.toThrow(
        f.path('local/package.json'),
      );
    },
  );

  it.each(['directory', 'dangling-symlink'])(
    'does not treat a manifest %s as absence',
    async (kind) => {
      const f = await fixture({
        'local/limina.config.mjs': 'export default {};',
      });
      await (kind === 'directory'
        ? mkdir(f.path('local/package.json'))
        : symlink(f.path('absent.json'), f.path('local/package.json')));
      await expect(f.load(f.path('local/limina.config.mjs'))).rejects.toThrow(
        f.path('local/package.json'),
      );
    },
  );

  it('fails a dangling same-root workspace descriptor without downgrading to single', async () => {
    const f = await fixture();
    await symlink(f.path('absent.yaml'), f.path('pnpm-workspace.yaml'));
    await expect(f.load()).rejects.toThrow();
  });

  it.each([
    [{}, [], /undetermined/u],
    [{}, ['yarn.lock', 'bun.lock'], /Ambiguous/u],
    [{ packageManager: 'invalid' }, [], /Invalid packageManager/u],
  ] as const)(
    'defers single manager capability failures: %j / %j',
    async (manifest, locks, error) => {
      const f = await fixture({ 'package.json': json(manifest) });
      for (const lock of locks) await f.write(lock, '');
      const config = await f.load();
      const rawPackages = await collectRawWorkspacePackages(config);
      const context = await collectValidatedWorkspaceContext({
        config,
        rawPackages,
      });
      expect(config.governanceRoot.kind).toBe('single-package');
      expect(context.packages).toHaveLength(1);
      expect(context.governanceRoot).toBe(config.governanceRoot);
      expect(() =>
        resolveGovernancePackageManager(config.governanceRoot),
      ).toThrow(error);
    },
  );

  it.each([
    [{ workspaces: [] }, /undetermined/u],
    [
      { workspaces: 'packages/*', packageManager: 'npm@1' },
      /workspace declaration/u,
    ],
    [{ workspaces: [], packageManager: 'invalid' }, /Invalid packageManager/u],
  ])(
    'fails invalid workspace authority without downgrading: %j',
    async (manifest, error) => {
      const f = await fixture({ 'package.json': json(manifest) });
      await expect(f.load()).rejects.toThrow(error as RegExp);
    },
  );

  it.each(['pnpm', 'npm', 'yarn', 'bun'])(
    'keeps a root-only %s workspace classified as workspace',
    async (manager) => {
      const f = await fixture({
        'package.json': json({
          workspaces: [],
          packageManager: `${manager}@1`,
        }),
      });
      if (manager === 'pnpm')
        await f.write('pnpm-workspace.yaml', 'packages: []');
      const config = await f.load();
      expect(config.governanceRoot.kind).toBe('workspace');
      expect(await collectRawWorkspacePackages(config)).toHaveLength(1);
    },
  );

  it.each([false, true])(
    'shares the root manifest fact across discovery and importers (workspace=%s)',
    async (workspace) => {
      const manifest = {
        scripts: { build: 'limina build tsconfig.json' },
        dependencies: { child: 'workspace:*' },
        ...(workspace
          ? { workspaces: ['child'], packageManager: 'npm@1' }
          : {}),
      };
      const f = await fixture({
        'package.json': json(manifest),
        'child/package.json': json({ name: 'child' }),
      });
      const config = await f.load();
      await f.write('package.json', '{');
      const rawPackages = await collectRawWorkspacePackages(config);
      const root = rawPackages.find((entry) => entry.directory === f.path());
      expect(root?.manifest).toBe(config.governanceRoot.manifest);
      expect(rawPackages).toHaveLength(workspace ? 2 : 1);
      const context = await collectValidatedWorkspaceContext({
        config,
        rawPackages,
      });
      expect(context.governanceRoot).toBe(config.governanceRoot);
      expect(
        cloneValidatedWorkspaceContext(context).packages.find(
          (entry) => entry.directory === f.path(),
        )?.manifest,
      ).toBe(config.governanceRoot.manifest);
      expect(
        collectImporters(config, rawPackages).find(
          (entry) => entry.directory === f.path(),
        )?.name,
      ).toBeUndefined();
      const declarations = collectWorkspaceDependencyDeclarations(context);
      expect(declarations).toHaveLength(workspace ? 1 : 0);
      if (workspace) {
        expect(declarations[0]?.importerIdentity).toBe(
          getPackageOwnerIdentity(context, f.path()),
        );
        expect(declarations[0]?.importer.name).toBeUndefined();
      }
      expect(
        collectPackageBuildScripts({ config, workspacePackages: rawPackages })
          .scripts,
      ).toHaveLength(1);
      expect(() => resolveGovernanceRoot(config.configPath)).toThrow(
        f.path('package.json'),
      );
    },
  );
});

describe('read-only issue query anchors', () => {
  it('accepts an explicit missing config without importing it or resolving workspace manager', async () => {
    const f = await fixture({
      'package.json': json({ workspaces: [], packageManager: 'invalid' }),
      'limina.config.mjs': 'throw new Error("query must not import config");',
    });
    expect(locateCheckIssueWorkspace({ cwd: f.path() }).rootDir).toBe(f.path());
    await rename(f.path('limina.config.mjs'), f.path('removed.mjs'));
    expect(
      locateCheckIssueWorkspace({ configPath: f.path('limina.config.mjs') }),
    ).toEqual({
      configPath: f.path('limina.config.mjs'),
      rootDir: f.path(),
    });
    expect(() => locateCheckIssueWorkspace({ cwd: f.path() })).toThrow(
      /Unable to find limina config/u,
    );
    await expect(f.load()).rejects.toThrow(/Unable to find limina config/u);
    await f.write('package.json', '[]');
    expect(() =>
      locateCheckIssueWorkspace({ configPath: f.path('limina.config.mjs') }),
    ).toThrow(f.path('package.json'));
  });
});
