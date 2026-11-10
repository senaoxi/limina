import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { selectArtifact } from './artifacts.ts';
import { classification, classificationBudget } from './classification.ts';
import {
  admitPlan,
  domains,
  fullPlan,
  jobName,
  matrices,
  policy,
  requirements,
  seal,
  stepName,
  tuples,
  unitMatrix,
} from './contract.ts';
import {
  actualResult,
  audit,
  evaluateDomain,
  executionOrigin,
  latestActual,
} from './evidence.ts';
import {
  contractHash,
  diff,
  gitText,
  isAncestor,
  nul,
  parseDiff,
} from './git.ts';
import { GitHub } from './github.ts';
import { History } from './history.ts';
import { finalize, prepare } from './planner.ts';
import { validatePublication } from './status.ts';
import type { ApiJob, ApiRun, JobReceipt, Plan, RunView } from './types.ts';

const identity = {
  repository: 'example/ci',
  repositoryId: 1,
  workflowId: 2,
  runId: 3,
  originAttempt: 1,
  event: 'push',
  ref: 'refs/heads/main',
  targetSha: 'a'.repeat(40),
  ancestryTrusted: true,
  forced: false,
};
function plan(): Plan {
  return fullPlan(identity, 'b'.repeat(64), '24.22.1', 'test');
}
it('forces release pushes through full validation even after main advances', async (context) => {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), 'affected-release-push-'),
  );
  const previous = process.cwd();
  const environment = {
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: '',
    GITHUB_REPOSITORY: identity.repository,
    GITHUB_REPOSITORY_ID: String(identity.repositoryId),
    GITHUB_RUN_ID: String(identity.runId),
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_WORKFLOW_REF:
      identity.repository + '/.github/workflows/ci.yml@refs/heads/main',
    GITHUB_OUTPUT: path.join(directory, 'outputs'),
    GH_TOKEN: 'local-fixture',
    ROLLING_NODE: '24.22.1',
    AFFECTED_CI: 'enabled',
  };
  const before = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  let headReads = 0;
  let currentHead = '';
  context.mock.method(
    GitHub.prototype,
    'run',
    async () => successfulView().run,
  );
  context.mock.method(GitHub.prototype, 'get', async () => {
    headReads++;
    return { object: { sha: currentHead } };
  });
  context.mock.method(History.prototype, 'resolve', async () => {
    assert.fail(
      'Forced release and obsolete ordinary pushes must not query checkpoints',
    );
  });
  try {
    Object.assign(process.env, environment);
    execFileSync('git', ['init', '-q'], { cwd: directory });
    process.chdir(directory);
    for (const [commitMessage, release, stale] of [
      ['release: limina@1.0.0, migrate@1.0.0', true, false],
      ['release: limina@1.0.1, migrate@1.0.1', true, true],
      ['Release: retain GitHub expression case semantics', true, true],
      ['docs: mention release: in the subject', false, true],
      ['docs: ordinary change\n\nrelease: body only', false, true],
      [' release: leading whitespace', false, true],
      ['release(scope): scoped type is not the prefix', false, true],
    ] as const) {
      execFileSync(
        'git',
        [
          '-c',
          'user.name=CI Test',
          '-c',
          'user.email=ci@example.invalid',
          'commit',
          '--allow-empty',
          '--cleanup=verbatim',
          '-q',
          '-F',
          '-',
        ],
        { input: commitMessage, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const target = gitText(['rev-parse', 'HEAD']);
      process.env.GITHUB_SHA = target;
      currentHead = stale ? 'f'.repeat(40) : target;
      headReads = 0;
      await prepare();
      finalize();
      const value = admitPlan(
        JSON.parse(readFileSync('.reports/ci/plan.json', 'utf8')),
      );
      assert.equal(value.targetSha, target);
      assert.equal(value.forced, release, commitMessage);
      assert.equal(value.mode, release ? 'full' : 'obsolete', commitMessage);
      assert.equal(headReads, release ? 0 : 1, commitMessage);
      if (!release) continue;
      assert.equal(value.reason, 'Forced full validation');
      assert.ok(
        domains.every((domain) => value.domains[domain].mode === 'run'),
      );
      assert.deepEqual(value.nativeTuples, tuples(value.rollingNode));
      assert.deepEqual(value.diffs, []);
      assert.equal(value.proposal, undefined);
    }
  } finally {
    process.chdir(previous);
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
function successfulView(value = plan()): RunView {
  const jobs: ApiJob[] = [];
  const receipts: JobReceipt[] = [];
  const inventory = requirements(value.rollingNode);
  for (const items of Object.values(inventory))
    for (const item of items) {
      const name = jobName(item.job, item.tuple, item.shard);
      let job = jobs.find((candidate) => candidate.name === name);
      if (!job) {
        job = {
          id: jobs.length + 100,
          run_id: value.runId,
          run_attempt: 1,
          name,
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-11-10T01:00:00Z',
          completed_at: '2026-11-10T01:02:00Z',
          steps: [],
        };
        jobs.push(job);
        receipts.push({
          schema: 1,
          repository: value.repository,
          runId: value.runId,
          executionAttempt: 1,
          job: item.job,
          tuple: item.tuple,
          shard: item.shard,
          targetSha: value.targetSha,
          planHash: value.planHash,
          contractHash: value.contractHash,
          steps: {},
          artifacts: [],
          createdAt: '2026-11-10T01:02:00Z',
        });
      }
      const receipt = receipts.find(
        (candidate) =>
          candidate.job === item.job &&
          candidate.tuple === item.tuple &&
          candidate.shard === item.shard,
      )!;
      for (const key of [...item.prerequisites, item.step]) {
        if (job.steps.every((step) => step.name !== stepName(key)))
          job.steps.push({
            name: stepName(key),
            number: job.steps.length + 1,
            status: 'completed',
            conclusion: 'success',
            started_at: '2026-11-10T01:00:01Z',
            completed_at: '2026-11-10T01:01:00Z',
          });
        receipt.steps[key] = { outcome: 'success', conclusion: 'success' };
      }
      if (
        item.artifact &&
        receipt.artifacts.every((artifact) => artifact.kind !== item.artifact)
      )
        receipt.artifacts.push({
          schema: 1,
          kind: item.artifact,
          repository: value.repository,
          runId: value.runId,
          producerAttempt: 1,
          producerJob: 'native-build',
          targetSha: value.targetSha,
          planHash: value.planHash,
          contractHash: value.contractHash,
          tuple: item.tuple,
          os: 'linux',
          arch: 'x64',
          node: '22.22.3',
          pnpm: '12.10.1',
          lockHash: 'c'.repeat(64),
          files: [],
          digest: 'd'.repeat(64),
        });
    }
  const run: ApiRun = {
    id: value.runId,
    workflow_id: 2,
    path: '.github/workflows/ci.yml',
    head_sha: value.targetSha,
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    run_attempt: 1,
    created_at: '2026-11-10T01:00:00Z',
    run_started_at: '2026-11-10T01:00:00Z',
    updated_at: '2026-11-10T01:02:00Z',
    repository: { id: 1, full_name: value.repository },
  };
  const source = { jobs, attempts: new Map([[1, jobs]]), receipts };
  return { ...source, run, plan: value, audit: audit(value, source, 1) };
}
function fail(view: RunView, key: string, conclusion = 'failure'): void {
  for (const job of view.jobs)
    for (const step of job.steps)
      if (step.name === stepName(key)) {
        step.conclusion = conclusion;
        job.conclusion = 'failure';
        const receipt = view.receipts.find(
          (entry) => jobName(entry.job, entry.tuple, entry.shard) === job.name,
        )!;
        receipt.steps[key] = { outcome: conclusion, conclusion };
      }
}
it('rejects cancelled macOS shards even when the enclosing aggregate reports success', () => {
  const view = successfulView();
  assert.equal(audit(view.plan, view, 1).state, 'candidate');
  for (const job of view.jobs)
    if (job.name.startsWith('CI limina-unit / darwin-'))
      job.conclusion = 'cancelled';
  assert.equal(view.run.conclusion, 'success'); // the misleading aggregate is deliberately unchanged
  const result = audit(view.plan, view, 1);
  assert.equal(result.state, 'failure');
  assert.equal(result.domains.limina_unit.errors.length, 2);
  assert.equal(result.domains.integration.status, 'success');
});
it('rejects a missing tuple, shard, step, receipt and masked continue-on-error independently', () => {
  const mutations = [
    (view: RunView) => {
      view.jobs.splice(
        view.jobs.findIndex((job) => job.name.startsWith('CI limina-unit')),
        1,
      );
    },
    (view: RunView) => {
      view.jobs
        .find((job) => job.name.startsWith('CI validation'))!
        .steps.pop();
    },
    (view: RunView) => {
      view.receipts.pop();
    },
    (view: RunView) => {
      view.receipts.find(
        (receipt) => receipt.steps.core_checker,
      )!.steps.core_checker!.outcome = 'failure';
    },
  ];
  for (const mutate of mutations) {
    const view = successfulView();
    mutate(view);
    assert.equal(audit(view.plan, view, 1).state, 'failure');
  }
});
it('keeps independent successful domains after Core, Migrate and Tooling failures', () => {
  for (const [step, failedDomain, independent] of [
    ['core_checker', 'core', 'migrate_unit'],
    ['migrate_unit', 'migrate_unit', 'tooling'],
    ['tooling', 'tooling', 'integration'],
  ] as const) {
    const view = successfulView();
    fail(view, step);
    assert.equal(
      evaluateDomain(view.plan, failedDomain, view).status,
      'failure',
    );
    assert.equal(
      evaluateDomain(view.plan, independent, view).status,
      'success',
    );
  }
  const view = successfulView();
  fail(view, 'restore');
  assert.equal(
    evaluateDomain(view.plan, 'integration', view).status,
    'failure',
  );
});
it('rejects required producer failures even when Core is unaffected, without advancing partial Core success', () => {
  const value = plan();
  value.mode = 'incremental';
  value.domains.core = {
    mode: 'unaffected',
    proof: {
      checkpoint: {
        domain: 'core',
        successfulSha: 'c'.repeat(40),
        runId: 2,
        viewAttempt: 1,
        contractHash: value.contractHash,
        planHash: 'd'.repeat(64),
        executions: [],
        completedAt: '2026-11-09T01:00:00Z',
      },
      diffDigest: 'e'.repeat(64),
      classificationDigest: 'f'.repeat(64),
      paths: ['docs/en/guide.md'],
      filters: {},
    },
  };
  const view = successfulView(seal(value));
  assert.equal(audit(view.plan, view, 1).state, 'candidate');
  assert.equal(actualResult(view, 'core'), undefined);
  fail(view, 'native_build');
  assert.equal(evaluateDomain(view.plan, 'docs', view).status, 'success');
  assert.equal(audit(view.plan, view, 1).state, 'failure');
  assert.equal(actualResult(view, 'core')?.status, 'failure');
  const delayed = successfulView();
  fail(delayed, 'upload_artifact');
  for (const job of delayed.jobs)
    for (const step of job.steps)
      if (step.name === stepName('upload_artifact'))
        step.completed_at = '2026-11-10T03:00:00Z';
  assert.equal(actualResult(delayed, 'core')?.at, '2026-11-10T03:00:00Z');
  const uploadFailure = successfulView();
  uploadFailure.jobs.find((job) =>
    job.name.startsWith('CI native-build /'),
  )!.conclusion = 'failure';
  assert.equal(audit(uploadFailure.plan, uploadFailure, 1).state, 'failure');
});
it('traces reused Jobs by original execution instead of their new API Job IDs', () => {
  const view = successfulView();
  const original = view.jobs[0]!;
  const copied = { ...structuredClone(original), id: 9000, run_attempt: 2 };
  const attempts = new Map([
    [1, [original]],
    [2, [copied]],
  ]);
  assert.equal(executionOrigin(copied, attempts).attempt, 1);
  assert.equal(executionOrigin(copied, attempts).job.id, original.id);
  assert.throws(() => executionOrigin(copied, new Map()), /Unknown execution/);
  assert.throws(
    () => executionOrigin(copied, new Map([[1, [original, original]]])),
    /Ambiguous/,
  );
});
it('allows a fresh rerun-all plan beyond the history budget without guessing retained producer origins', async (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'affected-recovery-'));
  const previous = process.cwd();
  const token = process.env.GH_TOKEN;
  const output = process.env.GITHUB_OUTPUT;
  process.env.GH_TOKEN = 'local-fixture';
  process.env.GITHUB_OUTPUT = path.join(directory, 'outputs');
  try {
    process.chdir(directory);
    const value = seal({ ...plan(), originAttempt: 31 });
    const view = successfulView(value);
    const producer = view.jobs.find(
      (job) => job.name === jobName('native-build', 'darwin-22.22.3'),
    )!;
    const visited: number[] = [];
    const api = new GitHub('example/ci');
    context.mock.method(api, 'run', async () => ({
      ...view.run,
      run_attempt: 31,
    }));
    context.mock.method(api, 'jobs', async (_run: number, attempt: number) => {
      visited.push(attempt);
      return [producer];
    });
    context.mock.method(api, 'artifacts', async () => [
      {
        id: 99,
        name: 'ci-native-a31-darwin-22.22.3-all-' + 'c'.repeat(64),
        expired: false,
      },
    ]);
    await selectArtifact(api, value, 'native', 'darwin-22.22.3');
    assert.deepEqual(visited, [31]);
    // Same timestamps outside the admitted source window cannot be guessed as a31.
    await assert.rejects(
      selectArtifact(
        api,
        seal({ ...value, originAttempt: 1 }),
        'native',
        'darwin-22.22.3',
      ),
      /Missing or ambiguous native artifact/,
    );
  } finally {
    process.chdir(previous);
    if (token === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = token;
    if (output === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = output;
    rmSync(directory, { recursive: true, force: true });
  }
});
it('does not let skipped runs hide a later actual failure or overwrite independent success', () => {
  const a = successfulView();
  const b = successfulView();
  fail(b, 'limina_unit');
  for (const job of b.jobs)
    for (const step of job.steps) step.completed_at = '2026-11-10T02:01:00Z';
  const c = successfulView();
  fail(c, 'limina_unit', 'skipped');
  const success = actualResult(a, 'limina_unit')!;
  const failure = actualResult(b, 'limina_unit')!;
  assert.equal(actualResult(c, 'limina_unit'), undefined);
  assert.equal(latestActual([success, failure])?.status, 'failure');
  assert.equal(latestActual([success])?.status, 'success');
  assert.equal(
    latestActual([success, failure, { ...success, at: '2026-11-10T03:01:00Z' }])
      ?.status,
    'success',
  );
  b.run.conclusion = 'failure';
  assert.equal(actualResult(b, 'integration')?.status, 'success');
  a.run.conclusion = 'cancelled';
  assert.equal(actualResult(a, 'limina_unit'), undefined);
  const untrusted = successfulView();
  untrusted.attempts.clear();
  assert.throws(
    () => actualResult(untrusted, 'limina_unit'),
    /Unknown execution source/,
  );
  c.plan = seal({ ...c.plan, mode: 'obsolete' });
  assert.equal(audit(c.plan, c, 1).state, 'obsolete');
});
it('seals complete physical coverage and rejects plan inventory tampering', () => {
  const value = plan();
  assert.equal(tuples(value.rollingNode).length, 8);
  assert.equal(unitMatrix(value.rollingNode).length, 10);
  assert.deepEqual(
    unitMatrix(value.rollingNode)
      .filter((tuple) => tuple.platform === 'win32')
      .map((tuple) => tuple.shard),
    ['1-4', '2-4', '3-4', '4-4'],
  );
  assert.equal(new Set(tuples('24.15.0').map((tuple) => tuple.key)).size, 7);
  assert.equal(admitPlan(value).mode, 'full');
  const altered = structuredClone(value);
  if (altered.domains.limina_unit.mode === 'run')
    altered.domains.limina_unit.required.pop();
  assert.throws(() => admitPlan(seal(altered)), /inventory/);
  const entries = Object.entries(matrices(value));
  for (const [key, encoded] of entries)
    if (key.endsWith('_matrix'))
      assert.ok(JSON.parse(encoded).include.length > 0);
});
function actionOutputs(
  paths: string[],
  classified: Record<string, string[]>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ['all_files', ...Object.keys(policy)]) {
    const values = name === 'all_files' ? paths : classified[name] || [];
    result[name] = String(values.length > 0);
    result[name + '_count'] = String(values.length);
    result[name + '_files'] = JSON.stringify(values);
  }
  return result;
}
it('audits actual paths independently of known filters and preserves unusual path bytes', () => {
  const paths = ['docs/a b.md', 'docs/tab\tline\n中文.md', '.agents/hidden.md'];
  const output = actionOutputs(paths, {
    docs_markdown: paths.slice(0, 2),
    repository_docs: paths.slice(2),
  });
  assert.deepEqual(classification(paths, output).affected, [
    'repository_gates',
    'docs',
  ]);
  assert.throws(
    () =>
      classification(
        [...paths, 'unknown/new'],
        actionOutputs([...paths, 'unknown/new'], { docs_markdown: paths }),
      ),
    /Unknown/,
  );
  assert.throws(() => classification(paths, {}), /inventory/);
  assert.throws(
    () => classification(paths, { ...output, all_files_files: '[]' }),
    /disagreement/,
  );
  assert.throws(
    () => classification(paths, { ...output, invented_files: '[]' }),
    /inventory/,
  );
  assert.throws(
    () =>
      classificationBudget([
        { paths: Array.from({ length: 1001 }, (_, index) => String(index)) },
      ]),
    /limit/,
  );
  assert.throws(
    () => classificationBudget([{ paths: ['x'.repeat(32_000)] }]),
    /limit/,
  );
});
it('uses net tree differences, both rename paths and baseline directory existence', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'affected-git-'));
  const run = (...arguments_: string[]) =>
    execFileSync('git', arguments_, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      .toString('utf8')
      .trim();
  const commit = () => {
    run('add', '--all');
    run(
      '-c',
      'user.name=CI Test',
      '-c',
      'user.email=ci@example.invalid',
      'commit',
      '-qm',
      'fixture',
    );
    return run('rev-parse', 'HEAD');
  };
  try {
    run('init', '-q');
    mkdirSync(path.join(cwd, 'docs'));
    writeFileSync(path.join(cwd, 'docs', 'old.md'), 'base');
    const a = commit();
    writeFileSync(path.join(cwd, 'docs', 'old.md'), 'failed');
    commit();
    writeFileSync(path.join(cwd, 'docs', 'old.md'), 'base');
    const reverted = commit();
    assert.deepEqual(diff(a, reverted, cwd).paths, []);
    const unusual = 'space tab\tline\n中文.md';
    // Git paths can contain characters that the Windows working tree cannot create.
    // Exercise the real NUL protocol through the index without weakening that case.
    const blob = run('rev-parse', a + ':docs/old.md');
    run('update-index', '--force-remove', 'docs/old.md');
    execFileSync('git', ['update-index', '-z', '--index-info'], {
      cwd,
      input: Buffer.from('100644 ' + blob + '\tdocs/' + unusual + '\0'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    run(
      '-c',
      'user.name=CI Test',
      '-c',
      'user.email=ci@example.invalid',
      'commit',
      '-qm',
      'index rename',
    );
    const renamed = run('rev-parse', 'HEAD');
    assert.deepEqual(diff(a, renamed, cwd).paths, [
      'docs/old.md',
      'docs/' + unusual,
    ]);
    mkdirSync(path.join(cwd, 'docs', 'new'));
    writeFileSync(path.join(cwd, 'docs', 'new', 'a.md'), 'new');
    const added = commit();
    assert.throws(() => diff(a, added, cwd), /New directory/);
    assert.equal(isAncestor(added, a, cwd), false);
    assert.throws(() => nul(Buffer.from([0xff, 0])), /encoded data/);
    assert.throws(
      () => parseDiff(Buffer.from('R100\0old\0new\0')),
      /Malformed/,
    );
    assert.throws(() => parseDiff(Buffer.from('T\0docs/a\0')), /Unsupported/);
    assert.equal(gitText(['rev-parse', 'HEAD'], cwd), added);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
it('proves a merge second-parent ancestor is not a base-history checkpoint', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'affected-merge-'));
  const run = (...arguments_: string[]) =>
    execFileSync('git', arguments_, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      .toString('utf8')
      .trim();
  const commit = () => {
    run('add', '--all');
    run(
      '-c',
      'user.name=CI Test',
      '-c',
      'user.email=ci@example.invalid',
      'commit',
      '-qm',
      'fixture',
    );
    return run('rev-parse', 'HEAD');
  };
  try {
    run('init', '-q');
    writeFileSync(path.join(cwd, 'base'), 'a');
    commit();
    run('checkout', '-qb', 'feature');
    writeFileSync(path.join(cwd, 'head'), 'b');
    const head = commit();
    run('checkout', '-qb', 'base', 'HEAD~1');
    writeFileSync(path.join(cwd, 'base'), 'c');
    const base = commit();
    run(
      '-c',
      'user.name=CI Test',
      '-c',
      'user.email=ci@example.invalid',
      'merge',
      '--no-ff',
      '-qm',
      'synthetic',
      head,
    );
    const merge = run('rev-parse', 'HEAD');
    assert.equal(isAncestor(head, merge, cwd), true);
    assert.equal(isAncestor(head, base, cwd), false);
    assert.equal(run('rev-parse', 'HEAD^1'), base);
    assert.equal(readFileSync(path.join(cwd, 'head'), 'utf8'), 'b');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

it('closes same-SHA history without a created/success filter and keeps later failure barriers', async (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'affected-history-'));
  const previous = process.cwd();
  const token = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'local-fixture';
  const run = (...arguments_: string[]) =>
    execFileSync('git', arguments_, {
      cwd: directory,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString('utf8')
      .trim();
  const commit = (content: string) => {
    writeFileSync(path.join(directory, 'file'), content);
    run('add', '--all');
    run(
      '-c',
      'user.name=CI Test',
      '-c',
      'user.email=ci@example.invalid',
      'commit',
      '-qm',
      'fixture',
    );
    return run('rev-parse', 'HEAD');
  };
  try {
    run('init', '-q');
    const a = commit('a');
    const b = commit('b');
    const current = commit('a');
    process.chdir(directory);
    const make = (targetSha: string, runId: number, ordinal: number) => {
      const value = fullPlan(
        { ...identity, targetSha, runId },
        contractHash(targetSha, '24.22.1'),
        '24.22.1',
        'fixture',
      );
      const view = successfulView(value);
      const completed = new Date(
        Date.now() - 3_600_000 + ordinal * 60_000,
      ).toISOString();
      for (const job of view.jobs)
        for (const step of job.steps) step.completed_at = completed;
      view.run.created_at = completed;
      return view;
    };
    const original = make(a, 10, 0);
    const priorSuccess = make(b, 11, 1);
    const laterFailure = make(b, 12, 2);
    fail(laterFailure, 'limina_unit');
    laterFailure.run.created_at = new Date(
      Date.now() - 60 * 86_400_000,
    ).toISOString();
    const skipped = make(b, 13, 3);
    fail(skipped, 'limina_unit', 'skipped');
    const views = [original, priorSuccess, laterFailure, skipped];
    const target = fullPlan(
      { ...identity, targetSha: current, runId: 99 },
      contractHash(current, '24.22.1'),
      '24.22.1',
      'current',
    );
    const api = new GitHub('example/ci');
    const queries: Record<string, string>[] = [];
    context.mock.method(api, 'runs', async (query: Record<string, string>) => {
      queries.push(query);
      return views
        .filter((view) =>
          query.head_sha
            ? view.run.head_sha === query.head_sha
            : view !== laterFailure,
        )
        .map((view) => view.run);
    });
    const history = new History(api, target);
    context.mock.method(
      history,
      'view',
      async (record: ApiRun) =>
        views.find((view) => view.run.id === record.id)!,
    );
    const result = await history.resolve();
    assert.equal(result.checkpoints.limina_unit.successfulSha, a);
    assert.equal(result.mustRun.has('limina_unit'), true);
    assert.equal(result.checkpoints.integration.successfulSha, b);
    assert.equal(result.mustRun.has('integration'), false);
    assert.deepEqual(diff(a, current).paths, []); // A known failure still forces execution after a revert.
    assert.ok(
      queries.some(
        (query) =>
          query.head_sha === b && !('created' in query) && !('status' in query),
      ),
    );
    laterFailure.run.status = 'in_progress';
    await assert.rejects(history.resolve(), /incomplete/);
  } finally {
    process.chdir(previous);
    if (token === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = token;
    rmSync(directory, { recursive: true, force: true });
  }
});
it('paginates API evidence and fails closed on record limits, truncation and timeouts', async (context) => {
  const token = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'local-fixture';
  try {
    const api = new GitHub('example/ci');
    const visited: string[] = [];
    context.mock.method(api, 'get', async (suffix: string) => {
      visited.push(suffix);
      return {
        total_count: 101,
        jobs: suffix.endsWith('page=1')
          ? Array.from({ length: 100 }, (_, index) => ({ id: index }))
          : [{ id: 100 }],
      };
    });
    assert.equal(
      (await api.pages('/actions/runs/1/attempts/1/jobs', 'jobs')).length,
      101,
    );
    assert.equal(visited.length, 2);
    const limited = new GitHub('example/ci');
    context.mock.method(limited, 'get', async () => ({
      total_count: 1001,
      jobs: [],
    }));
    await assert.rejects(limited.pages('/jobs', 'jobs'), /limit/);
    const truncated = new GitHub('example/ci');
    context.mock.method(truncated, 'get', async () => ({
      total_count: 1,
      jobs: [],
    }));
    await assert.rejects(truncated.pages('/jobs', 'jobs'), /Truncated/);
    assert.throws(() => new GitHub('example/ci', -1).remaining(), /exhausted/);
  } finally {
    if (token === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = token;
  }
});

it('requires the gate-selected successful push attempt and its complete publication receipt', async (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'affected-release-'));
  const previous = process.cwd();
  const token = process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  process.env.GH_TOKEN = 'local-fixture';
  process.env.GITHUB_REPOSITORY = 'example/ci';
  try {
    execFileSync('git', ['init', '-q'], { cwd: directory });
    writeFileSync(path.join(directory, 'source'), 'release fixture');
    execFileSync('git', ['add', '--all'], { cwd: directory });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=CI Test',
        '-c',
        'user.email=ci@example.invalid',
        'commit',
        '-qm',
        'fixture',
      ],
      { cwd: directory },
    );
    process.chdir(directory);
    const targetSha = gitText(['rev-parse', 'HEAD']);
    const value = fullPlan(
      { ...identity, targetSha },
      contractHash(targetSha, '24.22.1'),
      '24.22.1',
      'release',
    );
    const view = successfulView(value);
    const source = structuredClone(view.jobs[0]!);
    view.jobs.push(
      { ...source, id: 500, name: 'Plan' },
      { ...source, id: 501, name: 'CI Status' },
    );
    const artifacts = [
      {
        id: 1,
        name: 'ci-plan-a1-all-all',
        expired: false,
        created_at: value.createdAt,
      },
      {
        id: 2,
        name: 'ci-audit-a1-all-all',
        expired: false,
        created_at: value.createdAt,
      },
    ];
    let selectedRun = view.run;
    let receipt = view.audit;
    context.mock.method(GitHub.prototype, 'get', async () => ({
      workflow_runs: [selectedRun],
    }));
    context.mock.method(GitHub.prototype, 'artifacts', async () => artifacts);
    context.mock.method(GitHub.prototype, 'jobs', async () => view.jobs);
    context.mock.method(
      GitHub.prototype,
      'jsonArtifact',
      async (artifact: { id: number }) => (artifact.id === 1 ? value : receipt),
    );
    await validatePublication(view.run, targetSha);
    selectedRun = { ...view.run, id: 99, conclusion: 'cancelled' };
    await assert.rejects(
      validatePublication(view.run, targetSha),
      /Run changed/,
    );
    selectedRun = view.run;
    await assert.rejects(
      validatePublication(
        { ...view.run, event: 'workflow_dispatch' },
        targetSha,
      ),
      /main push/,
    );
    for (const changed of [
      { viewAttempt: 2 },
      { contractHash: '0'.repeat(64) },
      { createdAt: '2000-01-01T00:00:00Z' },
    ]) {
      receipt = { ...view.audit, ...changed };
      await assert.rejects(
        validatePublication(view.run, targetSha),
        /mismatch|expired/,
      );
    }
    receipt = view.audit;
    artifacts[1]!.expired = true;
    await assert.rejects(validatePublication(view.run, targetSha), /Missing/);
    artifacts[1]!.expired = false;
    fail(view, 'limina_unit', 'cancelled');
    await assert.rejects(
      validatePublication(view.run, targetSha),
      /inventory mismatch/,
    );
  } finally {
    process.chdir(previous);
    if (token === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = token;
    if (repo === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = repo;
    rmSync(directory, { recursive: true, force: true });
  }
});

it('loads the frozen plan from both single-artifact and multi-artifact download layouts', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'affected-plan-'));
  const cli = new URL('cli.ts', import.meta.url);
  const value = plan();
  try {
    const plans = path.join(directory, '.reports', 'ci', 'plans');
    mkdirSync(plans, { recursive: true });
    writeFileSync(path.join(plans, 'plan.json'), JSON.stringify(value));
    const run = () =>
      execFileSync(process.execPath, [fileURLToPath(cli), 'load-plan'], {
        cwd: directory,
        env: { ...process.env, CI_PLAN_HASH: value.planHash },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    run();
    {
      const restored = readFileSync(
        path.join(directory, '.reports', 'ci', 'plan.json'),
        'utf8',
      );
      assert.equal(JSON.parse(restored).planHash, value.planHash);
    }
    mkdirSync(path.join(plans, 'ci-plan-a1-all-all'));
    renameSync(
      path.join(plans, 'plan.json'),
      path.join(plans, 'ci-plan-a1-all-all', 'plan.json'),
    );
    mkdirSync(path.join(plans, 'ci-plan-a2-all-all'));
    writeFileSync(
      path.join(plans, 'ci-plan-a2-all-all', 'plan.json'),
      JSON.stringify({ schema: 999, planHash: 'different-contract' }),
    );
    run();
    {
      const restored = readFileSync(
        path.join(directory, '.reports', 'ci', 'plan.json'),
        'utf8',
      );
      assert.equal(JSON.parse(restored).planHash, value.planHash);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('freezes a docs-only plan but normalizes Action failures and unknown paths to all domains', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'affected-finalize-'));
  const runGit = (...arguments_: string[]) =>
    execFileSync('git', arguments_, {
      cwd: directory,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString('utf8')
      .trim();
  const commit = () => {
    runGit('add', '--all');
    runGit(
      '-c',
      'user.name=CI Test',
      '-c',
      'user.email=ci@example.invalid',
      'commit',
      '-qm',
      'fixture',
    );
    return runGit('rev-parse', 'HEAD');
  };
  try {
    runGit('init', '-q');
    mkdirSync(path.join(directory, 'docs'));
    writeFileSync(path.join(directory, 'docs', 'a.md'), 'base');
    const base = commit();
    writeFileSync(path.join(directory, 'docs', 'a.md'), 'target');
    const target = commit();
    const value = fullPlan(
      { ...identity, targetSha: target },
      'b'.repeat(64),
      '24.22.1',
      'fixture',
    );
    const checkpoints = Object.fromEntries(
      domains.map((domain) => [
        domain,
        {
          domain,
          successfulSha: base,
          runId: 1,
          viewAttempt: 1,
          contractHash: value.contractHash,
          planHash: 'c'.repeat(64),
          executions: [],
          completedAt: new Date().toISOString(),
        },
      ]),
    );
    const changed = diff(base, target, directory);
    const prepared = {
      plan: value,
      slots: [{ sha: base, ...changed }],
      checkpoints,
      mustRun: [],
    };
    prepared.plan.diffs = [{ baseSha: base, ...changed }];
    const reportDirectory = path.join(directory, '.reports', 'ci');
    mkdirSync(reportDirectory, { recursive: true });
    const output = path.join(directory, 'outputs');
    const raw = actionOutputs(changed.paths, { docs_markdown: changed.paths });
    const invoke = (mode: string, outcome = 'success', filter = raw) => {
      writeFileSync(
        path.join(reportDirectory, 'preparation.json'),
        JSON.stringify(prepared),
      );
      execFileSync(
        process.execPath,
        [fileURLToPath(new URL('cli.ts', import.meta.url)), 'finalize'],
        {
          cwd: directory,
          env: {
            ...process.env,
            AFFECTED_CI: mode,
            GITHUB_OUTPUT: output,
            FILTER_OUTCOME_0: outcome,
            FILTER_0: JSON.stringify(filter),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const content = readFileSync(
        path.join(reportDirectory, 'plan.json'),
        'utf8',
      );
      return admitPlan(JSON.parse(content));
    };
    const incremental = invoke('enabled');
    assert.equal(incremental.mode, 'incremental');
    assert.equal(incremental.domains.docs.mode, 'run');
    assert.equal(incremental.domains.limina_unit.mode, 'unaffected');
    assert.deepEqual(
      incremental.nativeTuples.map((tuple) => tuple.key),
      ['linux-22.22.3'],
    );
    assert.equal(incremental.analysis?.docs?.paths[0], 'docs/a.md');
    for (const value of [
      invoke('shadow'),
      invoke('enabled', 'failure'),
      invoke('enabled', 'success', actionOutputs(changed.paths, {})),
    ]) {
      assert.equal(value.mode, 'full');
      assert.ok(
        Object.values(value.domains).every((domain) => domain.mode === 'run'),
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
