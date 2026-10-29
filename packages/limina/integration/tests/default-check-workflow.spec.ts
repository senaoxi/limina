import { existsSync } from 'node:fs';
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createFixturePathResolver } from '../../src/__tests__/helpers/path';
import { LIMINA_CHECK_ISSUE_CODES as codes } from '../../src/check-reporting/codes';
import { readStandaloneIssueInvocation } from '../../src/check-reporting/invocation-snapshot';
import {
  getCheckIssueSnapshotPath,
  getSourceIssueSnapshotPath,
  readCheckIssueSnapshot,
} from '../../src/check-reporting/snapshot';
import { copyFixtureRepo } from '../helpers/fixture-sandbox';
import { runLimina } from '../helpers/run-limina';
import { createFixtureToolBridges } from '../helpers/tool-bridge';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture(name = 'detectors/checker/build-valid') {
  const temporary = await mkdtemp(
    path.join(tmpdir(), 'limina default workflow '),
  );
  const root = await realpath(temporary);
  roots.push(root);
  const file = createFixturePathResolver(root);
  const cwd = file('repo');
  await copyFixtureRepo({
    destinationRoot: cwd,
    sourceRoot: fileURLToPath(
      new URL(`../../fixtures/${name}/repo/`, import.meta.url),
    ),
  });
  await createFixtureToolBridges({
    fixtureId: name,
    repoRoot: cwd,
    tools: ['typescript'],
  });
  return {
    cwd,
    file: createFixturePathResolver(cwd),
    config: (value: unknown) =>
      writeFile(
        file('repo/limina.config.mts'),
        `export default ${JSON.stringify(value)};\n`,
      ),
    run: (arguments_: string[]) =>
      runLimina({ cwd, args: arguments_, fixtureName: name }),
  };
}

async function inventory(f: Awaited<ReturnType<typeof fixture>>) {
  const snapshot = await readCheckIssueSnapshot(f.cwd);
  expect(snapshot?.status).toBe('completed');
  expect(snapshot?.run).toBeDefined();
  const query = await f.run(['check', '--issues', '--format', 'json']);
  expect(query.code, query.stderr).toBe(0);
  expect(JSON.parse(query.stdout).run).toEqual(snapshot!.run);
  return snapshot!;
}

const defaultTasks = [
  'graph:check',
  'source:check',
  'proof:check',
  'checker:build',
  'checker:typecheck',
];
const full = {
  graph: { rules: {} },
  source: { knip: false },
  proof: { allowlist: [] },
};
const scope = { source: { include: ['packages/**/*.ts'] } };

it('refreshes all default task inventories after governance domains are omitted', async () => {
  const f = await fixture();
  await f.config({ ...full, scope });
  const first = await f.run(['check']);
  expect(first.code, first.stdout + first.stderr).toBe(0);
  const previous = await inventory(f);
  expect(
    previous
      .run!.tasks.filter((task) => task.kind === 'task')
      .map((task) => task.label),
  ).toEqual(defaultTasks);
  const sourcePath = getSourceIssueSnapshotPath(f.cwd);
  const sourceBytes = await readFile(sourcePath, 'utf8');
  await f.config({ scope });
  const second = await f.run(['check']);
  expect(second.code, second.stdout + second.stderr).toBe(0);
  const current = await inventory(f);
  expect(current.run!.createdAt).not.toEqual(previous.run!.createdAt);
  expect(current.run!.tasks.map((task) => [task.label, task.state])).toEqual([
    ['workspace:validate', 'passed'],
    ['graph:materialize', 'passed'],
    ['graph:check', 'passed'],
    ['source:check', 'passed'],
    ['proof:check', 'passed'],
    ['checker:build', 'passed'],
    ['checker:typecheck', 'disabled'],
  ]);
  expect(current.issues).toEqual([]);
  const refreshed = JSON.parse(await readFile(sourcePath, 'utf8'));
  expect(refreshed.createdAt).not.toBe(JSON.parse(sourceBytes).createdAt);
  expect(refreshed.status).toBe('completed');
  expect(refreshed.issues).toEqual([]);
});

it.each([undefined, { knip: false }])(
  'fails base source authorization with source=%j',
  async (sourceConfig) => {
    const f = await fixture('detectors/source/package-import-unauthorized');
    await f.config({
      scope,
      ...(sourceConfig !== undefined && { source: sourceConfig }),
    });
    const result = await f.run(['check']);
    expect(result.code).toBe(1);
    const snapshot = await inventory(f);
    expect(snapshot.issues).toContainEqual(
      expect.objectContaining({ code: codes.sourcePackageImportUnauthorized }),
    );
    const source = snapshot.run!.tasks.find(
      (task) => task.label === 'source:check',
    );
    expect(source?.state).toBe('failed');
    expect(source?.checkItems).toContainEqual(
      expect.objectContaining({ name: 'knip source usage', status: 'skipped' }),
    );
    expect(
      snapshot
        .run!.tasks.filter((task) => task.kind === 'task')
        .map((task) => task.label),
    ).toEqual(defaultTasks);
  },
);

it('runs the installed Knip when explicitly enabled', async () => {
  const f = await fixture();
  const require = createRequire(import.meta.url);
  const knipRoot = path.resolve(path.dirname(require.resolve('knip')), '..');
  await symlink(
    knipRoot,
    f.file('node_modules/knip'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await f.config({ source: { knip: true }, scope });
  const result = await f.run(['check']);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  const snapshot = await inventory(f);
  const source = snapshot.run!.tasks.find(
    (task) => task.label === 'source:check',
  );
  expect(source?.checkItems).toContainEqual(
    expect.objectContaining({
      name: 'knip source usage',
      status: 'passed',
    }),
  );
});

it('runs proof without a configured domain and keeps named pipelines authoritative', async () => {
  const f = await fixture('detectors/proof/coverage-missing');
  await f.config({
    scope,
    pipelines: { explicit: ['proof:check', 'graph:check'] },
  });
  expect((await f.run(['check'])).code).toBe(1);
  const automatic = await inventory(f);
  expect(automatic.issues).toContainEqual(
    expect.objectContaining({ code: codes.proofUncoveredSourceFile }),
  );
  expect(
    automatic
      .run!.tasks.filter((task) => task.kind === 'task')
      .map((task) => task.label),
  ).toEqual(defaultTasks);
  await f.config({
    scope,
    pipelines: { explicit: ['proof:check', 'graph:check'] },
  });
  expect((await f.run(['check', 'explicit'])).code).toBe(1);
  const explicit = await inventory(f);
  const tasks = explicit.run!.tasks.filter((task) => task.kind === 'task');
  expect(tasks.map((task) => task.label)).toEqual([
    'proof:check',
    'graph:check',
  ]);
  expect(tasks.map((task) => task.state)).toEqual(['failed', 'passed']);
  expect(Date.parse(tasks[1]!.startedAt!)).toBeGreaterThanOrEqual(
    Date.parse(tasks[0]!.completedAt!),
  );
});

it.each([
  [
    'graph',
    'detectors/graph/reference-cycle-mutual',
    codes.graphReferenceCycle,
  ],
  [
    'source',
    'detectors/source/package-import-unauthorized',
    codes.sourcePackageImportUnauthorized,
  ],
  ['proof', 'detectors/proof/coverage-missing', codes.proofUncoveredSourceFile],
] as const)(
  'runs explicit %s governance without a configured domain',
  async (command, name, code) => {
    const f = await fixture(name);
    await f.config({ scope });
    const result = await f.run([command, 'check']);
    expect(result.code, result.stdout + result.stderr).toBe(1);
    const records = await readdir(f.file('.limina/check/invocations'));
    expect(records).toHaveLength(1);
    const id = records[0]!.replace(/\.json$/u, '');
    const invocation = await readStandaloneIssueInvocation(f.cwd, id);
    expect(invocation.command).toBe(`limina ${command} check`);
    expect(invocation.issues).toContainEqual(expect.objectContaining({ code }));
    const query = await f.run([
      'check',
      '--issues',
      '--format',
      'json',
      '--invocation',
      id,
    ]);
    expect(query.code, query.stderr).toBe(0);
    expect(JSON.parse(query.stdout).invocationId).toBe(id);
  },
);

it.each([
  ['graph/config-invalid-rule', 'graph.rules.runtime.experimental'],
  [
    'source/knip-config-workspaces-invalid',
    'source.knip.workspaces["@fixture/source-knip-config"]',
  ],
] as const)(
  'rejects malformed %s before publishing a check attempt',
  async (name, field) => {
    const f = await fixture(`config-errors/${name}`);
    const result = await f.run(['check']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(field);
    expect(existsSync(getCheckIssueSnapshotPath(f.cwd))).toBe(false);
    expect(existsSync(f.file('.limina'))).toBe(false);
  },
);

it('records all default tasks and uncovered source with an empty config', async () => {
  const f = await fixture('detectors/proof/coverage-missing');
  await f.config({});
  expect((await f.run(['check'])).code).toBe(1);
  const snapshot = await inventory(f);
  expect(
    snapshot
      .run!.tasks.filter((task) => task.kind === 'task')
      .map((task) => task.label),
  ).toEqual(defaultTasks);
  expect(snapshot.issues).toContainEqual(
    expect.objectContaining({ code: codes.proofUncoveredSourceFile }),
  );
});

it('retains the historical invocation when a later config fails to load', async () => {
  const f = await fixture();
  await f.config({ scope });
  expect((await f.run(['check'])).code).toBe(0);
  const previous = await inventory(f);
  await f.config({ graph: {} });
  expect((await f.run(['check'])).code).toBe(1);
  expect(await readCheckIssueSnapshot(f.cwd)).toEqual(previous);
});
