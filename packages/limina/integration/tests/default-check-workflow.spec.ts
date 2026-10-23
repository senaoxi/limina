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

const checkerTasks = ['checker:build', 'checker:typecheck'];
const full = {
  graph: { rules: {} },
  source: { knip: false },
  proof: { allowlist: [] },
};
const scope = { source: { include: ['packages/**/*.ts'] } };

it('replaces a full check inventory with the current minimal plan', async () => {
  const f = await fixture();
  await f.config({ ...full, scope });
  const first = await f.run(['check']);
  expect(first.code, first.stdout + first.stderr).toBe(0);
  const previous = await inventory(f);
  expect(
    previous
      .run!.tasks.filter((task) => task.kind === 'task')
      .map((task) => task.label),
  ).toEqual(['graph:check', 'source:check', 'proof:check', ...checkerTasks]);
  const sourcePath = getSourceIssueSnapshotPath(f.cwd);
  const sourceBytes = await readFile(sourcePath, 'utf8');
  await f.config({});
  const second = await f.run(['check']);
  expect(second.code, second.stdout + second.stderr).toBe(0);
  const current = await inventory(f);
  expect(current.run!.createdAt).not.toEqual(previous.run!.createdAt);
  expect(current.run!.tasks.map((task) => [task.label, task.state])).toEqual([
    ['workspace:validate', 'passed'],
    ['graph:materialize', 'passed'],
    ['checker:build', 'passed'],
    ['checker:typecheck', 'disabled'],
  ]);
  expect(current.issues).toEqual([]);
  expect(await readFile(sourcePath, 'utf8')).toBe(sourceBytes);
});

it('fails source authorization with knip false in the default workflow', async () => {
  const f = await fixture('detectors/source/package-import-unauthorized');
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
  ).toEqual(['source:check', ...checkerTasks]);
});

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
  expect([0, 1]).toContain(result.code);
  const snapshot = await inventory(f);
  const source = snapshot.run!.tasks.find(
    (task) => task.label === 'source:check',
  );
  expect(source?.checkItems).toContainEqual(
    expect.objectContaining({
      name: 'knip source usage',
      status: expect.stringMatching(/^(passed|failed)$/u),
    }),
  );
});

it('runs proof without exceptions and keeps named pipelines authoritative', async () => {
  const f = await fixture('detectors/proof/coverage-missing');
  await f.config({
    proof: { allowlist: [] },
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
  ).toEqual(['proof:check', ...checkerTasks]);
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

it('retains the historical invocation when a later config fails to load', async () => {
  const f = await fixture();
  await f.config({});
  expect((await f.run(['check'])).code).toBe(0);
  const previous = await inventory(f);
  await f.config({ graph: {} });
  expect((await f.run(['check'])).code).toBe(1);
  expect(await readCheckIssueSnapshot(f.cwd)).toEqual(previous);
});
