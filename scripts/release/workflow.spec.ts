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
import { parse } from 'yaml';

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
