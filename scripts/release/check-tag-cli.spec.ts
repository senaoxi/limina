import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

it('checks real tag checkout, source versions and main ancestry without migration metadata', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'limina-tag-check-'));
  const root = realpathSync(temporary);
  const git = (...arguments_: string[]) =>
    execFileSync('git', arguments_, { cwd: root, encoding: 'utf8' }).trim();
  const setVersions = (core: string, migrate = core) => {
    for (const [directory, name, version] of [
      ['limina', 'limina', core],
      ['migrate', 'limina-migrate', migrate],
    ]) {
      const target = path.join(root, 'packages', directory!, 'package.json');
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(
        target,
        JSON.stringify({ name, version, publishConfig: { access: 'public' } }),
      );
    }
  };
  const checkTag = (tag: string) =>
    spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        path.join(root, 'scripts/release/check-tag-cli.ts'),
      ],
      {
        cwd: root,
        env: { ...process.env, RELEASE_TAG: tag },
        encoding: 'utf8',
      },
    );
  try {
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ private: true, type: 'module' }),
    );
    const scripts = path.join(root, 'scripts/release');
    mkdirSync(scripts, { recursive: true });
    for (const file of [
      'check-tag-cli.ts',
      'check-tag.ts',
      'shared.ts',
      'command.ts',
    ])
      copyFileSync(
        fileURLToPath(new URL(file, import.meta.url)),
        path.join(scripts, file),
      );
    // Tooling dependencies stay outside the fixture's source-version inputs.
    const dependencies = fileURLToPath(
      new URL('../../node_modules/', import.meta.url),
    );
    for (const name of [
      '@limina/build-tools',
      'logaria',
      'prompts',
      'semver',
    ]) {
      const target = path.join(root, 'node_modules', name);
      mkdirSync(path.dirname(target), { recursive: true });
      symlinkSync(
        realpathSync(path.join(dependencies, name)),
        target,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
    setVersions('1.2.3-beta.1');
    git('init', '--quiet');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'Tag fixture');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'tag.gpgsign', 'false');
    git('add', 'package.json', 'packages');
    git('commit', '--quiet', '-m', 'fixture release');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const tag = 'limina/v1.2.3-beta.1';
    git('tag', tag);
    const accepted = checkTag(tag);
    assert.equal(accepted.status, 0, accepted.stderr);

    setVersions('1.2.3-beta.1', '1.2.4');
    const mismatch = checkTag(tag);
    assert.notEqual(mismatch.status, 0);
    assert.match(
      mismatch.stderr,
      /match both source package names and versions/u,
    );
    setVersions('1.2.3-beta.1');
    writeFileSync(
      path.join(root, 'packages/migrate/package.json'),
      JSON.stringify({
        name: 'limina-migrate',
        version: '1.2.3-beta.1',
        publishConfig: { access: 'public' },
        private: true,
      }),
    );
    const incomplete = checkTag(tag);
    assert.notEqual(incomplete.status, 0);
    assert.match(incomplete.stderr, /both source package names and versions/u);

    setVersions('0.4.0');
    git('tag', 'limina/v0.4.0');
    const historical = checkTag('limina/v0.4.0');
    assert.notEqual(historical.status, 0);
    assert.match(historical.stderr, /Imported historical tags/u);
    setVersions('1.2.3-beta.1');

    const malformed = checkTag('limina/v1.2.3/../main');
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.stderr, /Expected a new/u);

    git('commit', '--quiet', '--allow-empty', '-m', 'unapproved descendant');
    const wrongCheckout = checkTag(tag);
    assert.notEqual(wrongCheckout.status, 0);
    assert.match(wrongCheckout.stderr, /exact approved tagged commit/u);

    git('tag', '--force', tag);
    const outsideMain = checkTag(tag);
    assert.notEqual(outsideMain.status, 0);
    assert.match(outsideMain.stderr, /merge-base/u);

    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('tag', '--force', '--annotate', tag, '-m', 'approved annotated tag');
    const annotated = checkTag(tag);
    assert.equal(annotated.status, 0, annotated.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
