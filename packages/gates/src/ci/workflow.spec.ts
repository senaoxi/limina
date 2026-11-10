import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { parse } from 'yaml';
import {
  fullPlan,
  jobName,
  matrices,
  requirements,
  stepName,
} from './contract.ts';

interface Step {
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  'continue-on-error'?: boolean;
  with?: Record<string, unknown>;
}
interface Job {
  name: string;
  needs?: string[];
  if?: string;
  strategy?: { 'fail-fast': boolean; matrix: string };
  steps: Step[];
}
interface Workflow {
  on: { push: object; pull_request: object };
  jobs: Record<string, Job>;
  concurrency: { group: string; 'cancel-in-progress': string };
  env: Record<string, string>;
}
function workflow(): Workflow {
  return parse(
    readFileSync(
      new URL('../../../../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    ),
  ) as Workflow;
}
it('routes every planned execution to a real Job/Step and preserves independent Step conditions', () => {
  const value = workflow();
  const required = requirements('24.22.1');
  const conditions: string[] = [];
  for (const items of Object.values(required))
    for (const execution of items) {
      const job = value.jobs[execution.job];
      assert.ok(job, execution.job);
      for (const key of [...execution.prerequisites, execution.step]) {
        const matches = job.steps.filter(
          (step) => step.name === stepName(key) && step.id === key,
        );
        assert.equal(
          matches.length,
          1,
          jobName(execution.job, execution.tuple, execution.shard) + ':' + key,
        );
        assert.notEqual(matches[0]!['continue-on-error'], true);
      }
    }
  const validation = value.jobs.validation!;
  for (const key of [
    'core_checker',
    'package_validation',
    'migrate_unit',
    'tooling',
    'limina_integration',
    'migrate_integration',
  ]) {
    const step = validation.steps.find((entry) => entry.id === key)!;
    assert.ok(step.if?.includes('!cancelled()'));
    for (const prerequisite of ['checkout', 'setup', 'admit', 'restore'])
      assert.ok(
        step.if?.includes(`steps.${prerequisite}.outcome == 'success'`),
      );
    assert.ok(step.if?.includes(`steps.admit.outputs.run_${key} == 'true'`));
    conditions.push(step.if!.replace(`run_${key}`, 'run_domain'));
  }
  assert.equal(new Set(conditions).size, 1);
  assert.deepEqual(value.jobs['repository-gates']!.needs, ['plan']);
  assert.deepEqual(value.jobs['native-build']!.needs, ['plan']);
  assert.deepEqual(value.jobs['native-build-linux22']!.needs, [
    'plan',
    'repository-gates',
  ]);
  for (const name of [
    'limina-unit',
    'validation',
    'platform-smoke',
    'windows-behavior',
  ]) {
    assert.ok(value.jobs[name]!.needs?.includes('native-build'));
    assert.ok(value.jobs[name]!.if?.includes('!cancelled()'));
    assert.ok(
      !value.jobs[name]!.if?.includes("needs.native-build.result == 'success'"),
    );
  }
});
it('never removes CI from the trigger, keeps Status stable and fails matrix expansion safely', () => {
  const value = workflow();
  assert.equal('paths' in value.on.push, false);
  assert.equal('paths' in value.on.pull_request, false);
  const status = value.jobs.status!;
  assert.equal(status.name, 'CI Status');
  assert.equal(status.if, '${{ always() }}');
  assert.deepEqual(
    new Set(status.needs),
    new Set(Object.keys(value.jobs).filter((job) => job !== 'status')),
  );
  assert.ok(status.steps.some((step) => step.run?.endsWith('cli.ts status')));
  assert.equal(
    JSON.stringify(status).includes('contains(needs.*.result'),
    false,
  );
  for (const job of Object.values(value.jobs))
    if (job.strategy) {
      assert.equal(job.strategy['fail-fast'], false);
      assert.match(
        job.strategy.matrix,
        /fromJSON\(needs\.plan\.outputs\.[a-z_]+ \|\| '\{"include":\[/,
      );
    }
  const plan = fullPlan(
    {
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
    },
    'b'.repeat(64),
    '24.22.1',
    'fixture',
  );
  const output = matrices(plan);
  assert.equal(JSON.parse(output.validation_matrix!).include.length, 6);
  assert.equal(JSON.parse(output.unit_matrix!).include.length, 10);
  assert.equal(JSON.parse(output.smoke_matrix!).include.length, 5);
  assert.equal(JSON.parse(output.native_matrix!).include.length, 7);
  assert.ok(value.env.AFFECTED_CI?.includes("|| 'shadow'"));
});
it('pins local Git classification, isolates recovery concurrency and checks release receipts', () => {
  const value = workflow();
  const filters = value.jobs.plan!.steps.filter((step) =>
    step.uses?.startsWith('dorny/paths-filter@'),
  );
  assert.equal(filters.length, 10);
  for (const filter of filters) {
    assert.equal(
      filter.uses,
      'dorny/paths-filter@ceb8a2b8f2d89434be7ff52d3de7ec3738c5cc9d',
    );
    assert.equal(filter.with?.token, '');
    assert.equal(filter.with?.['list-files'], 'json');
    assert.equal(filter.with?.['predicate-quantifier'], 'some-with-excludes');
  }
  for (const group of [
    'CI-release-',
    'CI-pr-',
    'CI-retry-',
    'CI-push-main',
    'CI-schedule-main',
    'CI-dispatch-',
  ])
    assert.ok(value.concurrency.group.includes(group));
  assert.ok(
    value.concurrency['cancel-in-progress'].includes('github.run_attempt == 1'),
  );
  assert.ok(
    value.concurrency.group.startsWith(
      "${{ github.event_name == 'push' && startsWith(github.event.head_commit.message, 'release:') && format('CI-release-{0}', github.run_id)",
    ),
  );
  assert.ok(
    value.concurrency['cancel-in-progress'].includes(
      "!startsWith(github.event.head_commit.message, 'release:')",
    ),
  );
  const publication = parse(
    readFileSync(
      new URL('../../../../.github/workflows/publish-npm.yml', import.meta.url),
      'utf8',
    ),
  ) as { jobs: { publish: Job } };
  const steps = publication.jobs.publish.steps;
  const gate = steps.findIndex((step) =>
    step.run?.includes('cli.ts publish .reports/release/ci.json'),
  );
  const publish = steps.findIndex((step) =>
    step.run?.includes('scripts/release/publish-approved.ts'),
  );
  assert.ok(gate > 0 && gate < publish);
  assert.ok(
    steps.some((step) =>
      step.run?.includes('-f branch=main -f event=push -f per_page=1'),
    ),
  );
});
