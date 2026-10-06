import {
  buildChangelogSection,
  createReleasePlanFromVersionSelection,
  insertChangelogSection,
} from '@limina/gates/release/changelog';
import {
  execReleaseCommand,
  resolveReleaseCommand,
} from '@limina/gates/release/command';
import {
  compareVersions,
  getReleasePackageConfigs,
  isValidVersion,
  type ResolvedReleasePackageConfig,
  selectPreviousGitTag,
  sortTagsByVersion,
} from '@limina/gates/release/shared';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import repoConfig from '../../limina.config.mjs';

function releaseConfig(version: string): ResolvedReleasePackageConfig {
  return {
    key: 'limina',
    packageName: 'limina',
    tagPrefix: 'limina',
    relativeDir: '.',
    publishRelativeDir: 'dist',
    changelogRelativePath: 'CHANGELOG.md',
    changelogPaths: [],
    previewChecks: [],
    packageDir: '.',
    publishDir: '.',
    changelogPath: 'CHANGELOG.md',
    manifestPath: 'package.json',
    manifest: { name: 'limina', version },
  };
}

function plan(from: string, to: string) {
  return createReleasePlanFromVersionSelection(releaseConfig(from), {
    mode: 'custom',
    version: to,
  });
}

function planWithTag(tag: string) {
  return createReleasePlanFromVersionSelection(
    releaseConfig('1.2.3-beta.1'),
    { mode: 'prerelease' },
    { explicitNpmTag: tag },
  );
}

it('renders nonempty changelogs without migration maps and preserves historical links', () => {
  const section = buildChangelogSection(
    '1.2.3',
    [
      '1d82962 feat: imported feature',
      'b1f1150 fix: standalone repair',
      'abc1234 docs: clarify behavior',
      'def5678 build: refresh tooling',
      'fed4321 other change',
    ],
    '2026-10-02',
  );
  assert.ok(
    section.includes(
      '[1d82962](https://github.com/senaoxi/limina/commit/1d82962)',
    ),
  );
  assert.ok(
    section.includes(
      '[b1f1150](https://github.com/senaoxi/limina/commit/b1f1150)',
    ),
  );
  for (const title of [
    'Features',
    'Bug Fixes',
    'Documentation',
    'Maintenance',
    'Other Changes',
  ])
    assert.ok(section.includes(`### ${title}`));
  const history =
    '## [0.4.0]\n\n- Imported fix ([017ef49](https://github.com/senaoxi/docs-islands/commit/017ef494b51a3c99084bacc5dc7e69531f125e71))\n';
  const output = insertChangelogSection(
    `# Changelog\n\n## [Unreleased]\n\n${history}`,
    section,
  );
  assert.ok(output.includes(section));
  assert.ok(output.endsWith(history));
});

describe('release version precedence', () => {
  it('uses the selected prerelease identifier and derives the channel from the resulting version', () => {
    for (const [from, preId, to, tag] of [
      ['1.2.3-beta.1', 'rc', '1.2.3-rc.0', 'rc'],
      ['1.2.3-beta.1', undefined, '1.2.3-beta.2', 'beta'],
      ['1.2.3-alpha.1', 'beta', '1.2.3-beta.0', 'beta'],
      ['1.2.3-beta.1.9', undefined, '1.2.3-beta.1.10', 'beta'],
      ['1.2.3', 'rc', '1.2.4-rc.0', 'rc'],
      ['1.2.3', undefined, '1.2.4-alpha.0', 'alpha'],
      ['1.2.3', '1', '1.2.4-1.0', 'next'],
    ] as const) {
      const result = createReleasePlanFromVersionSelection(
        releaseConfig(from),
        {
          mode: 'prerelease',
          preId,
        },
      );
      assert.equal(result.newVersion, to);
      assert.equal(result.npmTag, tag);
    }
    assert.equal(plan('1.2.3', '1.3.0-1.0').npmTag, 'next');
    assert.throws(
      () =>
        createReleasePlanFromVersionSelection(releaseConfig('1.2.3-beta.1'), {
          mode: 'prerelease',
          preId: 'alpha',
        }),
      /must be greater/u,
    );
    assert.throws(
      () =>
        createReleasePlanFromVersionSelection(releaseConfig('1.2.3-beta.1'), {
          mode: 'prerelease',
          preId: '1.2.3-beta.2',
        }),
      /use --version/u,
    );
  });
  it('rejects invalid explicit channels during planning and retains valid overrides', () => {
    for (const tag of [
      '1.2.3-beta.2',
      '>=1.2',
      '1',
      '',
      'beta next',
      ' beta',
      '--beta',
    ])
      assert.throws(() => planWithTag(tag), /Invalid npm tag/u);
    assert.equal(planWithTag('canary').npmTag, 'canary');
  });
  it('compares numeric prerelease identifiers numerically at every depth', () => {
    for (const [before, after] of [
      ['1.0.0-beta.9', '1.0.0-beta.10'],
      ['1.0.0-2', '1.0.0-10'],
      ['1.0.0-beta.1.9', '1.0.0-beta.1.10'],
    ]) {
      assert.ok(compareVersions(before!, after!) < 0);
      assert.ok(compareVersions(after!, before!) > 0);
    }
  });
  it('respects identifier kind, lexical order, prefix and stable precedence', () => {
    const versions = [
      '1.0.0-1',
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];
    for (let index = 1; index < versions.length; index++)
      assert.ok(compareVersions(versions[index - 1]!, versions[index]!) < 0);
    assert.equal(compareVersions('1.0.0-beta.10', '1.0.0-beta.10'), 0);
  });
  it('accepts numeric prerelease upgrades and rejects downgrades and equality', () => {
    assert.equal(
      plan('1.0.0-beta.9', '1.0.0-beta.10').newVersion,
      '1.0.0-beta.10',
    );
    assert.equal(plan('1.0.0-beta.10', '1.0.0').gitTag, 'limina/v1.0.0');
    assert.throws(
      () => plan('1.0.0-beta.10', '1.0.0-beta.2'),
      /must be greater/u,
    );
    assert.throws(
      () => plan('1.0.0-beta.10', '1.0.0-beta.10'),
      /must be greater/u,
    );
    assert.throws(() => plan('1.0.1', '1.0.0'), /must be greater/u);
  });
  it('selects the newest package tag and retains the legacy fallback', () => {
    const tags = ['limina/v1.0.0-beta.9', 'limina/v1.0.0-beta.10'];
    assert.equal(
      selectPreviousGitTag({ tagPrefix: 'limina', legacyTagPrefix: 'v' }, [
        ...tags,
        'other/v9.0.0',
        'v2.0.0',
      ]),
      tags[1],
    );
    assert.deepEqual(sortTagsByVersion(tags.toReversed()), [tags[1], tags[0]]);
    assert.equal(
      selectPreviousGitTag({ tagPrefix: 'limina', legacyTagPrefix: 'v' }, [
        'v1.0.0-2',
        'v1.0.0-10',
      ]),
      'v1.0.0-10',
    );
  });
  it('retains the existing input format and tag construction', () => {
    assert.equal(isValidVersion('v1.0.0'), false);
    assert.equal(isValidVersion('1.0.0+metadata'), false);
    assert.throws(
      () => compareVersions('v1.0.0', '1.0.0'),
      /Invalid version format/u,
    );
    assert.equal(plan('1.0.0', '1.0.1').gitTag, 'limina/v1.0.1');
  });
});

describe('Windows release npm execution', () => {
  it('preserves argv, cwd and error output through a JavaScript launcher', () => {
    const temporary = mkdtempSync(
      path.join(tmpdir(), 'limina npm & ^ %PATH% !L! (x)-'),
    );
    const directory = realpathSync(temporary);
    try {
      const entry = path.join(directory, 'node_modules/npm/bin/npm-cli.js');
      mkdirSync(path.dirname(entry), { recursive: true });
      writeFileSync(path.join(directory, 'npm.cmd'), 'not executable');
      writeFileSync(
        entry,
        `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
if (process.argv.includes('fail')) {
  process.stderr.write('controlled npm failure');
  process.exit(17);
}`,
      );
      const sentinel = path.join(directory, 'injected.txt');
      const arguments_ = [
        'pack',
        '--pack-destination',
        path.join(directory, 'output with spaces'),
        '空格漢字',
        `& echo injected > "${sentinel}"`,
        '^caret',
        '%PATH%',
        '!L!',
        '(x)',
        'a"b',
        'line1\nline2',
      ];
      const environment = {
        ...process.env,
        PATH: directory,
        npm_execpath: 'pnpm.cjs',
      };
      const resolved = resolveReleaseCommand('npm.cmd', arguments_, {
        cwd: directory,
        env: environment,
        execPath: process.execPath,
        platform: 'win32',
      });
      assert.equal(resolved.command, process.execPath);
      assert.deepEqual(resolved.arguments, [entry, ...arguments_]);
      const command =
        process.platform === 'win32' ? 'npm.cmd' : resolved.command;
      const argv =
        process.platform === 'win32' ? arguments_ : resolved.arguments;
      const options = {
        cwd: directory,
        env: environment,
        encoding: 'utf8' as const,
        stdio: 'pipe' as const,
      };
      assert.deepEqual(JSON.parse(execReleaseCommand(command, argv, options)), {
        argv: arguments_,
        cwd: directory,
      });
      assert.equal(existsSync(sentinel), false);
      assert.throws(
        () => execReleaseCommand(command, [...argv, 'fail'], options),
        (error: unknown) => {
          const result = error as {
            status?: number;
            stderr?: string;
            stdout?: string;
          };
          assert.equal(result.status, 17);
          assert.equal(result.stderr, 'controlled npm failure');
          assert.deepEqual(JSON.parse(result.stdout!), {
            argv: [...arguments_, 'fail'],
            cwd: directory,
          });
          return true;
        },
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('respects npm identity and fails closed for an unsupported first PATH shim', () => {
    const temporary = mkdtempSync(
      path.join(tmpdir(), 'limina-npm-resolution-'),
    );
    const directory = realpathSync(temporary);
    try {
      const first = path.join(directory, 'first');
      const second = path.join(directory, 'second');
      const entry = path.join(second, 'node_modules/npm/bin/npm-cli.js');
      mkdirSync(first, { recursive: true });
      mkdirSync(path.dirname(entry), { recursive: true });
      writeFileSync(path.join(first, 'npm.cmd'), 'custom shim');
      writeFileSync(path.join(second, 'npm.cmd'), 'npm shim');
      writeFileSync(entry, '');
      const context = {
        cwd: directory,
        env: { PATH: `${first};${second}`, Path: second },
        execPath: process.execPath,
        platform: 'win32' as const,
      };
      assert.throws(
        () => resolveReleaseCommand('npm.cmd', [], context),
        /beside/,
      );
      assert.deepEqual(
        resolveReleaseCommand('npm.cmd', ['--version'], {
          ...context,
          env: { ...context.env, npm_execpath: entry },
        }),
        { command: process.execPath, arguments: [entry, '--version'] },
      );
      assert.deepEqual(resolveReleaseCommand('git.exe', ['status'], context), {
        command: 'git.exe',
        arguments: ['status'],
      });
      assert.deepEqual(
        resolveReleaseCommand('npm', ['--version'], {
          ...context,
          platform: 'darwin',
        }),
        { command: 'npm', arguments: ['--version'] },
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

it('publishes the governed product artifact from a private workspace root', () => {
  const [release] = getReleasePackageConfigs();
  const root = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  const product = JSON.parse(
    readFileSync(
      new URL('../../packages/limina/package.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(root.private, true);
  assert.notEqual(product.private, true);
  assert.equal(release?.relativeDir, 'packages/limina');
  assert.equal(release?.packageName, product.name);
  assert.deepEqual(
    repoConfig.package?.entries?.map(({ name, outDir }) => ({
      name,
      outDir,
    })),
    getReleasePackageConfigs().map((config) => ({
      name: config.packageName,
      outDir: config.publishRelativeDir,
    })),
  );
});
