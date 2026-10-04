import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

it('allows manual publication in the owning repository without an activation variable', () => {
  const workflow = parse(
    readFileSync(
      new URL('../../.github/workflows/publish-npm.yml', import.meta.url),
      'utf8',
    ),
  ) as {
    on: { workflow_dispatch?: unknown };
    jobs: { publish: { if: string; environment: string } };
  };
  assert.ok(workflow.on.workflow_dispatch);
  assert.equal(
    workflow.jobs.publish.if,
    "github.repository == 'senaoxi/limina'",
  );
  assert.equal(workflow.jobs.publish.environment, 'Release');
});

for (const workflowFile of ['publish-npm.yml', 'deploy-docs.yml'])
  it(`bootstraps private tools before checking a cold ${workflowFile} checkout`, () => {
    const workflow = parse(
      readFileSync(
        new URL(`../../.github/workflows/${workflowFile}`, import.meta.url),
        'utf8',
      ),
    ) as { jobs: Record<string, { steps: { run?: string }[] }> };
    const steps = Object.values(workflow.jobs)[0]!.steps;
    const tagCheck = steps.findIndex((step) =>
      step.run?.includes('pnpm run release:check-tag'),
    );
    const bootstrap = steps.findIndex((step) =>
      step.run?.includes('pnpm run build:tools'),
    );
    assert.ok(tagCheck !== -1, 'publication must check the release tag');
    assert.ok(
      bootstrap !== -1 && bootstrap < tagCheck,
      'the tag CLI needs the private logger compiled before package resolution',
    );
  });

it(
  'requires successful main push workflows at the checked-out release SHA',
  { skip: process.platform === 'win32' },
  () => {
    const temporary = mkdtempSync(path.join(tmpdir(), 'limina release CI '));
    const root = realpathSync(temporary);
    try {
      const workflow = parse(
        readFileSync(
          new URL('../../.github/workflows/publish-npm.yml', import.meta.url),
          'utf8',
        ),
      ) as { jobs: { publish: { steps: { run?: string }[] } } };
      const step = workflow.jobs.publish.steps.find((entry) =>
        entry.run?.includes('actions/workflows/'),
      );
      assert.ok(step?.run, 'publication must check the remote workflow runs');
      execFileSync('git', ['init', '--quiet'], { cwd: root });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '--quiet',
          '--allow-empty',
          '-m',
          'release',
        ],
        { cwd: root },
      );
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).trim();
      const bin = path.join(root, 'bin');
      mkdirSync(bin);
      const gh = path.join(bin, 'gh');
      writeFileSync(
        gh,
        `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CAPTURE, JSON.stringify(args) + '\\n');
if (process.env.CASE === 'lookup-error') process.exit(1);
const run = { head_sha: process.env.RELEASE_SHA, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', html_url: 'https://github.com/senaoxi/limina/actions/runs/1' };
if (args.some(arg => arg.includes('security.yml'))) {
  if (process.env.CASE === 'wrong-sha') run.head_sha = 'f'.repeat(40);
  if (process.env.CASE === 'wrong-branch') run.head_branch = 'other';
  if (process.env.CASE === 'pull-request') run.event = 'pull_request';
  if (process.env.CASE === 'pending') run.status = 'in_progress';
  if (['failure', 'cancelled', 'skipped'].includes(process.env.CASE)) run.conclusion = process.env.CASE;
}
process.stdout.write(process.env.CASE === 'missing' ? '{"workflow_runs":[]}' : JSON.stringify({workflow_runs:[run]}));
`,
      );
      chmodSync(gh, 0o755);
      const script = path.join(root, 'check-ci.sh');
      writeFileSync(script, step.run);
      const capture = path.join(root, 'calls.jsonl');
      const run = (scenario: string) =>
        execFileSync('bash', [script], {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${bin}${path.delimiter}${process.env.PATH}`,
            CAPTURE: capture,
            CASE: scenario,
            RELEASE_SHA: sha,
            GITHUB_SHA: scenario === 'dispatch-sha' ? '0'.repeat(40) : sha,
            GITHUB_REPOSITORY: 'senaoxi/limina',
          },
          stdio: 'pipe',
        });
      writeFileSync(capture, '');
      run('success');
      const calls = readFileSync(capture, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      assert.equal(calls.length, 3);
      for (const file of ['ci.yml', 'security.yml', 'codeql.yml']) {
        const call = calls.find((arguments_) =>
          arguments_.some((argument) =>
            argument.includes(`actions/workflows/${file}/runs`),
          ),
        );
        assert.ok(call, file);
        for (const filter of [`head_sha=${sha}`, 'branch=main', 'event=push'])
          assert.ok(call.includes(filter), filter);
      }
      for (const scenario of [
        'wrong-sha',
        'wrong-branch',
        'pull-request',
        'pending',
        'failure',
        'cancelled',
        'skipped',
        'missing',
        'lookup-error',
        'dispatch-sha',
      ])
        assert.throws(() => run(scenario), /Command failed/u, scenario);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it(
  'rejects npm versions without trusted dist-tag support before package operations',
  { skip: process.platform === 'win32' },
  () => {
    const temporary = mkdtempSync(path.join(tmpdir(), 'limina release npm '));
    const root = realpathSync(temporary);
    try {
      const npm = path.join(root, 'npm');
      writeFileSync(
        npm,
        `#!/usr/bin/env node
if (process.argv[2] !== '--version') process.exit(99);
process.stdout.write(process.env.FIXTURE_NPM_VERSION + '\\n');
`,
      );
      chmodSync(npm, 0o755);
      const run = (version: string) =>
        execFileSync(
          process.execPath,
          [
            '--import',
            import.meta.resolve('tsx'),
            fileURLToPath(new URL('publish-approved.ts', import.meta.url)),
          ],
          {
            env: {
              ...process.env,
              PATH: `${root}${path.delimiter}${process.env.PATH}`,
              FIXTURE_NPM_VERSION: version,
              RELEASE_TAG: 'fixture-invalid-tag',
            },
            stdio: 'pipe',
          },
        );
      for (const version of ['11.6.1', '11.20.0', '12.0.0', '12.1.0'])
        assert.throws(run.bind(undefined, version), /trusted.*dist-tag/iu);
      for (const version of ['11.21.0', '12.2.0'])
        assert.throws(
          run.bind(undefined, version),
          /matching limina version tag/u,
        );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it(
  'links GitHub releases to the shared changelog at the approved checkout',
  // The publication workflow runs Bash on Ubuntu; Windows does not own it.
  { skip: process.platform === 'win32' },
  () => {
    const temporary = mkdtempSync(path.join(tmpdir(), 'limina release notes '));
    const root = realpathSync(temporary);
    const git = (...arguments_: string[]) =>
      execFileSync('git', arguments_, { cwd: root, encoding: 'utf8' }).trim();
    try {
      const workflow = parse(
        readFileSync(
          new URL('../../.github/workflows/publish-npm.yml', import.meta.url),
          'utf8',
        ),
      ) as { jobs: { publish: { steps: { run?: string }[] } } };
      const step = workflow.jobs.publish.steps.find((entry) =>
        entry.run?.includes('gh release create'),
      );
      assert.ok(step?.run);
      const changelog = path.join(root, 'packages/limina/CHANGELOG.md');
      mkdirSync(path.dirname(changelog), { recursive: true });
      writeFileSync(changelog, '# Shared release changelog\n');
      git('init', '--quiet');
      git('config', 'user.email', 'fixture@example.invalid');
      git('config', 'user.name', 'Release notes fixture');
      git('config', 'commit.gpgsign', 'false');
      git('config', 'tag.gpgsign', 'false');
      git('add', 'packages');
      git('commit', '--quiet', '-m', 'approved changelog');
      const commit = git('rev-parse', 'HEAD');
      const script = path.join(root, 'release.sh');
      writeFileSync(script, step.run);
      const bin = path.join(root, 'bin');
      mkdirSync(bin);
      const gh = path.join(bin, 'gh');
      writeFileSync(
        gh,
        `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CAPTURE, JSON.stringify(args) + '\\n');
if (args[0] === 'api') {
  process.stderr.write('gh: Not Found (HTTP 404)');
  process.exit(1);
}
`,
      );
      chmodSync(gh, 0o755);
      for (const tag of ['limina/v1.2.3', 'limina/v1.2.3-beta.1']) {
        git('tag', tag);
        const capture = path.join(root, 'calls.jsonl');
        writeFileSync(capture, '');
        execFileSync('bash', [script], {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${bin}${path.delimiter}${process.env.PATH}`,
            CAPTURE: capture,
            GH_TOKEN: 'fixture-only',
            GITHUB_REPOSITORY: 'senaoxi/limina',
            GITHUB_SHA: '1'.repeat(40),
            RELEASE_TAG: tag,
          },
          encoding: 'utf8',
        });
        const calls = readFileSync(capture, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as string[]);
        const create = calls.find((call) => call[0] === 'release');
        assert.ok(create);
        assert.deepEqual(create.slice(0, 3), ['release', 'create', tag]);
        const notes = create[create.indexOf('--notes') + 1]!;
        const links = notes
          .matchAll(
            /https:\/\/github\.com\/senaoxi\/limina\/blob\/([a-f0-9]{40})\/([^\s)]+)/gu,
          )
          .toArray();
        assert.equal(links.length, 1, notes);
        const [, linkedCommit, relativePath] = links[0]!;
        assert.equal(linkedCommit, commit);
        assert.match(relativePath!, /CHANGELOG\.md$/u);
        git('cat-file', '-e', `${linkedCommit}:${relativePath}`);
        assert.equal(create.includes('--prerelease'), tag.includes('-beta.'));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
