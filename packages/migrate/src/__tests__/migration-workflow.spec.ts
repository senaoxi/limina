import { createLiminaArtifactNamespace } from 'limina/internal/domain/artifacts/namespace';
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { runMigration } from '../migration';
import { createFrozenMigrationPlan } from '../migration/planner';
import {
  assertMigrationScopeUnchanged,
  discoverMigrationScope,
  loadMigrationScope,
} from '../migration/scope';
import { createWritePlanPreview } from '../migration/write-plan';
import { createFixturePathResolver } from './helpers/path';

const roots: string[] = [];
const json = (value: unknown) => `${JSON.stringify(value)}\n`;
async function fixture(extra: Record<string, string> = {}) {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), 'limina-workflow-'),
  );
  const rootDirectory = await realpath(temporaryDirectory);
  roots.push(rootDirectory);
  const locate = createFixturePathResolver(rootDirectory);
  const files = {
    'package.json': json({ name: 'fixture', type: 'module' }),
    '.gitignore': '.limina/\n',
    'index.ts': 'export {};\n',
    'tsconfig.json': json({ files: ['index.ts'] }),
    ...extra,
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(locate(file)), { recursive: true });
    await writeFile(locate(file), content);
  }
  return { rootDir: locate(), path: locate };
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function snapshot(directory: string): Promise<unknown> {
  const entries: unknown[] = [];
  const names = await readdir(directory);
  names.sort((left, right) => left.localeCompare(right));
  for (const name of names) {
    const file = path.join(directory, name);
    const metadata = await lstat(file, { bigint: true });
    entries.push([
      name,
      metadata.mode,
      metadata.mtimeNs,
      metadata.isDirectory() ? await snapshot(file) : await readFile(file),
    ]);
  }
  return entries;
}

it('prioritizes configs across child manifests and uses the nearest manifest only for defaults', async () => {
  const f = await fixture({
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    'limina.config.mjs': 'export default {};',
    'limina.config.mts': 'export default {};',
    'packages/app/package.json': json({ name: 'app' }),
  });
  const cwd = f.path('packages/app');
  expect(discoverMigrationScope({ cwd })).toMatchObject({
    root: { rootDir: f.rootDir, kind: 'workspace' },
    source: { configPath: f.path('limina.config.mts') },
  });
  await writeFile(
    f.path('packages/app/limina.config.mjs'),
    'export default {};',
  );
  expect(discoverMigrationScope({ cwd })).toMatchObject({
    root: { rootDir: cwd, kind: 'single-package' },
    source: {
      discovery: 'ancestor',
      configPath: f.path('packages/app/limina.config.mjs'),
    },
  });
  expect(
    discoverMigrationScope({ cwd, configPath: '../../limina.config.mjs' }),
  ).toMatchObject({
    root: { rootDir: f.rootDir },
    source: { discovery: 'explicit', configPath: f.path('limina.config.mjs') },
  });
  expect(() =>
    discoverMigrationScope({ cwd, configPath: 'missing.mjs' }),
  ).toThrow('Unable to find limina config');
  for (const file of [
    'limina.config.mjs',
    'limina.config.mts',
    'packages/app/limina.config.mjs',
  ])
    await rm(f.path(file));
  const scope = discoverMigrationScope({ cwd });
  expect(scope).toMatchObject({
    source: { kind: 'defaults' },
    root: { rootDir: cwd, kind: 'single-package' },
  });
  expect(await loadMigrationScope(scope)).not.toHaveProperty('configPath');
});

it.each(['{broken', '[]'])(
  'rejects the invalid nearest manifest instead of adopting an ancestor for %s',
  async (content) => {
    const f = await fixture({ 'child/package.json': content });
    expect(() => discoverMigrationScope({ cwd: f.path('child') })).toThrow(
      /package.json/u,
    );
  },
);

it('discovers without evaluating configuration and rejects selection or root drift before loading', async () => {
  const f = await fixture();
  const defaults = discoverMigrationScope({ cwd: f.rootDir });
  await writeFile(
    f.path('limina.config.mjs'),
    "import fs from 'node:fs';fs.writeFileSync(new URL('./evaluated',import.meta.url),'yes');export default {};",
  );
  await expect(loadMigrationScope(defaults)).rejects.toThrow(
    'Migration scope changed',
  );
  const selected = discoverMigrationScope({ cwd: f.rootDir });
  await expect(lstat(f.path('evaluated'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await writeFile(
    f.path('package.json'),
    json({ name: 'changed', type: 'module' }),
  );
  expect(() => assertMigrationScopeUnchanged(selected)).toThrow(
    'Migration scope changed',
  );
  await expect(lstat(f.path('evaluated'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('previews final patches, normalizes checker-excluded sources and performs no writes', async () => {
  const f = await fixture({
    'limina.config.mjs':
      "export default {scope:{checkers:{auto:{exclude:['excluded/**']}}}};",
    'excluded/tsconfig.json': json({ files: ['index.ts'] }),
    'excluded/index.ts': 'export {};',
    'bad/tsconfig.json': '{broken',
  });
  const config = await loadMigrationScope(
    discoverMigrationScope({ cwd: f.rootDir }),
  );
  const before = await snapshot(f.rootDir);
  const plan = await createFrozenMigrationPlan(
    config,
    createLiminaArtifactNamespace({ rootDir: f.rootDir, generation: 0 }),
  );
  const preview = createWritePlanPreview(plan, f.rootDir);
  expect(preview.operations.map((item) => item.path)).toEqual([
    f.path('excluded/tsconfig.json'),
    f.path('limina.config.mjs'),
    f.path('tsconfig.json'),
  ]);
  expect(preview.isolated.map((item) => item.path)).toEqual([
    f.path('bad/tsconfig.json'),
  ]);
  const result = await runMigration(config, { dryRun: true });
  expect(result).toMatchObject({
    outcome: 'preview',
    previewComplete: true,
    inputConsumable: false,
    modifiedFiles: [],
  });
  expect(await snapshot(f.rootDir)).toEqual(before);
});

it.each([
  '{"$schema":"a","$schema":"b","files":["index.ts"]}',
  '{"files":[],"references":[]}',
])(
  'keeps incomplete and source-free previews free of migration writes for %s',
  async (content) => {
    const f = await fixture({ 'tsconfig.json': content });
    const config = await loadMigrationScope(
      discoverMigrationScope({ cwd: f.rootDir }),
    );
    const before = await snapshot(f.rootDir);
    expect(await runMigration(config, { dryRun: true })).toMatchObject({
      outcome: 'preview',
      previewComplete: false,
      inputConsumable: false,
    });
    expect(await snapshot(f.rootDir)).toEqual(before);
  },
);

it.each([false, true])(
  'validates actual defaults inputs or the required created config from disk (isolation=%s)',
  async (isolation) => {
    const f = await fixture(
      isolation ? { 'bad/tsconfig.json': '{broken' } : {},
    );
    const git = (arguments_: string[]) =>
      promisify(execFile)('git', arguments_, { cwd: f.rootDir });
    await git(['init']);
    await git(['add', '.']);
    await git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--no-gpg-sign',
      '-m',
      'fixture',
    ]);
    const scope = discoverMigrationScope({ cwd: f.rootDir });
    const config = await loadMigrationScope(scope);
    const result = await runMigration(config, { scope });
    expect(result).toMatchObject({
      outcome: 'applied',
      inputSource: { kind: 'defaults' },
      inputConsumable: true,
      verificationSource: { kind: isolation ? 'file' : 'defaults' },
    });
    if (isolation) {
      expect(await readFile(f.path('bad/tsconfig.json'), 'utf8')).toBe(
        '{broken',
      );
      expect(await readFile(f.path('limina.config.mjs'), 'utf8')).toContain(
        'exclude',
      );
      expect(result.modifiedFiles).toContain(f.path('limina.config.mjs'));
    } else
      await expect(lstat(f.path('limina.config.mjs'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
  },
);

it('counts reused relationships from final patches even when analysis records are repeated', async () => {
  const f = await fixture({
    'tsconfig.json': json({
      files: ['index.ts'],
      references: [{ path: './dep' }],
      liminaOptions: {
        implicitRefs: [
          { path: './dep/tsconfig.json', reason: 'Keep the user reason' },
        ],
      },
    }),
    'dep/tsconfig.json': json({ files: ['index.ts'] }),
    'dep/index.ts': 'export {};',
  });
  const config = await loadMigrationScope(
    discoverMigrationScope({ cwd: f.rootDir }),
  );
  const plan = await createFrozenMigrationPlan(
    config,
    createLiminaArtifactNamespace({ rootDir: f.rootDir, generation: 0 }),
  );
  const preview = createWritePlanPreview(plan, f.rootDir);
  const actions = preview.operations.find(
    (operation) => operation.path === f.path('tsconfig.json'),
  )!.actions;
  expect(actions).toContain(
    'implicitRefs reused: 1; existing reasons preserved',
  );
  expect(
    actions.some((action) => action.startsWith('implicitRefs added:')),
  ).toBe(false);
  plan.records.push(...plan.records);
  expect(createWritePlanPreview(plan, f.rootDir).operations).toEqual(
    preview.operations,
  );
});
