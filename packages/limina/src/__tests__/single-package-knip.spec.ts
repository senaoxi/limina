import {
  collectImporters,
  collectPackageOwners,
  collectRawWorkspacePackages,
} from '#core/workspace/actions';
import { readFile, rm, symlink } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { runSourceCheck } from '../commands/source';
import { collectWorkspaceDependencyDeclarations } from '../core/packages/dependency-authority';
import { createWorkspaceLookupIndex } from '../core/workspace/lookup';
import { getPackageOwnerIdentity } from '../core/workspace/owner-identity';
import {
  collectValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../core/workspace/validated-context';
import type { SourceFinding } from '../source-check/findings';
import type { KnipCliInvocation } from '../source-check/knip';
import { createKnipConfigForSourceAnalysis } from '../source-check/knip/config';
import { collectUnusedDependencyIgnore } from '../source-check/knip/dependency-ignore';
import { collectOwnerSourceModuleSets } from '../source-check/knip/owner-modules';
import { collectUnusedWorkspaceDependencyIssues } from '../source-check/knip/report-issues';
import { collectSourceKnipWorkspaceConfigs } from '../source-check/knip/workspace-config';
import type { SourceCheckIssue } from '../source-check/report';
import { createSinglePackageFixture } from './helpers/single-package';

const cleanups: (() => Promise<void>)[] = [];
async function fixture(files: Record<string, string> = {}) {
  const f = await createSinglePackageFixture(files);
  cleanups.push(f.cleanup);
  return f;
}
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
const json = JSON.stringify;
const tsconfig = json({
  compilerOptions: {
    noEmit: true,
    module: 'ESNext',
    moduleResolution: 'Bundler',
  },
  include: ['src/**/*.ts'],
});

async function validated(f: Awaited<ReturnType<typeof fixture>>) {
  const config = await f.load();
  const rawPackages = await collectRawWorkspacePackages(config);
  const context = await collectValidatedWorkspaceContext({
    config,
    rawPackages,
  });
  return { config, context };
}

describe('Knip governance root contract', () => {
  it.each([false, true])(
    'routes root entries and file ignores through real Knip (workspace=%s)',
    async (workspace) => {
      const root = {
        exports: { '.': './src/index.ts' },
        ...(workspace ? { workspaces: [], packageManager: 'npm@1' } : {}),
      };
      const f = await fixture({
        'package.json': json(root),
        'limina.config.mjs':
          'export default { source: { knip: { root: { entry: [{ files: ["src/runtime.ts"], reason: "Runtime entry" }], ignoreFiles: [{ file: "src/ignored.ts", reason: "Intentional fixture" }] } } } };',
        'tsconfig.json': tsconfig,
        'src/index.ts': 'export const value = 1;',
        'src/runtime.ts': 'export const runtime = 1;',
        'src/ignored.ts': 'export const ignored = 1;',
        'src/dead.ts': 'export const dead = 1;',
      });
      for (const name of [undefined, 'named-root']) {
        await f.write('package.json', json({ ...root, name }));
        const issues: SourceCheckIssue[] = [];
        expect(
          await runSourceCheck(await f.load(), { sourceIssues: issues }),
        ).toBe(false);
        const snapshot = { sourceIssues: issues };
        expect(snapshot.sourceIssues).toHaveLength(1);
        expect(snapshot.sourceIssues[0]).toMatchObject({
          code: 'LIMINA_SOURCE_UNUSED_MODULE',
          filePath: f.path('src/dead.ts'),
        });
        expect(JSON.stringify(snapshot)).toContain('source.knip.root');
        expect(JSON.stringify(snapshot)).not.toContain('workspaces[undefined]');
      }
    },
    30_000,
  );

  it.each([false, true])(
    'rejects both root aliases even without root config (workspace=%s)',
    async (workspace) => {
      const f = await fixture({
        'package.json': json({
          name: 'root-name',
          ...(workspace ? { workspaces: [], packageManager: 'npm@1' } : {}),
        }),
      });
      for (const alias of ['.', 'root-name']) {
        await f.write(
          'limina.config.mjs',
          `export default ${json({
            source: { knip: { workspaces: { [alias]: {} } } },
          })}`,
        );
        const { config, context } = await validated(f);
        const findings: SourceFinding[] = [];
        expect(
          collectSourceKnipWorkspaceConfigs({
            config,
            workspaceContext: context,
            findings,
          }).size,
        ).toBe(0);
        expect(findings).toHaveLength(1);
        expect(findings[0]?.reason).toContain('source.knip.root');
      }
    },
  );

  it('does not reactivate an excluded root', async () => {
    const f = await fixture({
      'limina.config.mjs':
        'export default { source: { knip: { root: {} } }, regions: { exclude: [{kind: "workspace-package", include: ["."], reason: "Root excluded"}] } };',
    });
    const { config, context } = await validated(f);
    const findings: SourceFinding[] = [];
    expect(context.packages).toHaveLength(0);
    expect(
      collectSourceKnipWorkspaceConfigs({
        config,
        workspaceContext: context,
        findings,
      }).size,
    ).toBe(0);
    expect(findings[0]?.reason).toContain('cannot activate an excluded root');
  });

  it('retains nameless root dependency authority and canonical alias deduplication', async () => {
    const f = await fixture({
      'package.json': json({
        workspaces: ['child'],
        packageManager: 'npm@1',
        dependencies: { child: '*' },
      }),
      'child/package.json': json({ name: 'child' }),
      'src/index.ts': 'export const value = 1;',
      'limina.config.mjs':
        'export default { source: { knip: { root: { ignoreDependencies: [{ dep: "child", reason: "Runtime use" }] } } } };',
    });
    await symlink(f.path(), f.path('alias'), 'junction');
    const { config, context } = await validated(f);
    const findings: SourceFinding[] = [];
    const ownerIdentity = getPackageOwnerIdentity(context, f.path());
    const declarations = collectWorkspaceDependencyDeclarations(context);
    expect(declarations).toHaveLength(1);
    expect(declarations[0]?.importerIdentity).toBe(ownerIdentity);
    expect(declarations[0]?.importer.name).toBeUndefined();
    const configs = collectSourceKnipWorkspaceConfigs({
      config,
      workspaceContext: context,
      findings,
    });
    const ignoredKeys = collectUnusedDependencyIgnore({
      declarations,
      findings,
      knipWorkspaceConfigs: configs,
      workspacePackages: [...context.packages],
    });
    expect(findings).toHaveLength(0);
    const generated = createKnipConfigForSourceAnalysis({
      rootDir: config.rootDir,
      workspaceContext: context,
      workspacePackages: context.packages,
      ownerProjects: [],
      ignoredKeys,
    });
    expect(generated.workspaces?.['.']?.ignoreDependencies).toEqual(['child']);
    const dependencyIssues = collectUnusedWorkspaceDependencyIssues({
      report: {
        issues: ['package.json', 'alias/package.json'].map((file) => ({
          file,
          dependencies: [{ name: 'child' }],
        })),
      },
      rootDir: config.rootDir,
      workspaceContext: context,
      workspacePackageNames: new Set(['child']),
    });
    expect(dependencyIssues).toHaveLength(1);
    expect(dependencyIssues[0]?.ownerIdentity).toBe(ownerIdentity);
    const pathIndex = new WorkspaceRegionPathIndex(context);
    const workspaceLookup = createWorkspaceLookupIndex({
      rootDir: config.rootDir,
      pathIndex,
      packages: [...context.packages],
      owners: await collectPackageOwners(config),
      importers: collectImporters(config, [...context.packages]),
    });
    const modules = collectOwnerSourceModuleSets({
      sourceProjectEntries: [
        { fileNames: [f.path('src/index.ts'), f.path('alias/src/index.ts')] },
      ],
      workspaceContext: context,
      workspaceLookup,
      pathIndex,
    });
    expect(modules).toHaveLength(1);
    expect(modules[0]?.ownerIdentity).toBe(ownerIdentity);
    expect(modules[0]?.files).toEqual([f.path('src/index.ts')]);
  });

  it('keeps dependency ownership at the validated directory when the root manifest is a symlink', async () => {
    const f = await fixture({
      'manifest.data.json': json({
        workspaces: ['child'],
        packageManager: 'npm@1',
        dependencies: { child: '*' },
      }),
      'child/package.json': json({ name: 'child' }),
    });
    await rm(f.path('package.json'));
    await symlink(f.path('manifest.data.json'), f.path('package.json'));
    const { config, context } = await validated(f);
    const issues = collectUnusedWorkspaceDependencyIssues({
      report: {
        issues: [{ file: 'package.json', dependencies: [{ name: 'child' }] }],
      },
      rootDir: config.rootDir,
      workspaceContext: context,
      workspacePackageNames: new Set(['child']),
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.ownerIdentity).toBe(
      getPackageOwnerIdentity(context, f.path()),
    );
  });

  it('rejects two activated aliases of a nameless physical package before Knip', async () => {
    const f = await fixture({
      'package.json': json({
        workspaces: ['real', 'alias'],
        packageManager: 'npm@1',
      }),
      'real/package.json': '{}',
    });
    await symlink(f.path('real'), f.path('alias'), 'junction');
    await expect(validated(f)).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'LIMINA_WORKSPACE_PACKAGE_IDENTITY_CONFLICT',
        }),
      ]),
    });
  });

  it('keeps root source inference and multiple tsconfig groups when name is added or removed', async () => {
    const root = {
      exports: { '.': './dist/one/index.js' },
      scripts: {
        one: 'limina build tsconfig.one.json --raw --preset tsc',
        two: 'limina build tsconfig.two.json --raw --preset tsc',
      },
    };
    const buildConfig = (name: string) =>
      json({
        compilerOptions: {
          declaration: true,
          emitDeclarationOnly: true,
          module: 'ESNext',
          moduleResolution: 'Bundler',
          rootDir: './src',
          outDir: `./dist/${name}`,
        },
        include: ['src/**/*.ts'],
      });
    const f = await fixture({
      'package.json': json(root),
      'tsconfig.json': tsconfig,
      'tsconfig.one.json': buildConfig('one'),
      'tsconfig.two.json': buildConfig('two'),
      'src/index.ts': 'export const value = 1;',
      'limina.config.mjs': 'export default { source: { knip: { root: {} } } };',
    });
    const runs: { invocations: KnipCliInvocation[]; configs: unknown[] }[] = [];
    for (const name of [undefined, 'root-name']) {
      await f.write('package.json', json({ ...root, name }));
      const run = {
        invocations: [] as KnipCliInvocation[],
        configs: [] as unknown[],
      };
      expect(
        await runSourceCheck(await f.load(), {
          knipRunner: async (invocation) => {
            run.invocations.push(invocation);
            run.configs.push(
              JSON.parse(await readFile(invocation.configPath, 'utf8')),
            );
            return '{"issues":[]}';
          },
        }),
      ).toBe(true);
      expect(run.invocations.map((entry) => entry.workspaceNames)).toEqual([
        ['.'],
        ['.'],
      ]);
      expect(run.invocations.map((entry) => entry.tsConfigFile).sort()).toEqual(
        ['tsconfig.one.json', 'tsconfig.two.json'],
      );
      runs.push(run);
    }
    expect(runs[0]?.configs).toEqual(runs[1]?.configs);
    expect(JSON.stringify(runs[0]?.configs)).toContain('src/index.ts');
  });
});
