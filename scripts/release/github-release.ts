import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertNewReleaseTag } from './check-tag';
import {
  discoverReleasePackages,
  getNpmCommand,
  REPO_ROOT,
  runCommand,
} from './shared';

interface ReleaseAsset {
  name: string;
}
interface GithubRelease {
  draft: boolean;
  tag_name: string;
  assets: ReleaseAsset[];
}
interface Artifact {
  name: string;
  version: string;
  filename: string;
  integrity: string;
}

const githubRepo = process.env.GITHUB_REPOSITORY;
if (
  githubRepo !== 'senaoxi/limina' ||
  process.env.LIMINA_RELEASE_ENABLED !== '1'
) {
  throw new Error(
    'GitHub release creation requires the approved repository release gate.',
  );
}
const tag = process.env.RELEASE_TAG ?? '';
const importedTags = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'migration/original-tags.json'), 'utf8'),
) as Record<string, string>;
const version = assertNewReleaseTag(tag, Object.keys(importedTags));
const reportDirectory = path.join(REPO_ROOT, '.reports/release');
const artifacts = JSON.parse(
  readFileSync(path.join(reportDirectory, 'artifacts.json'), 'utf8'),
) as Artifact[];
if (
  artifacts.length !== 2 ||
  new Set(artifacts.map((artifact) => artifact.name)).size !== 2
) {
  throw new Error(
    'Both package artifacts are required before creating a release.',
  );
}
const packages = discoverReleasePackages();
const files = ['README.md', 'artifacts.json'];
for (const config of packages) {
  const artifact = artifacts.find((entry) => entry.name === config.packageName);
  if (!artifact) {
    throw new Error(`Missing artifact report for ${config.packageName}.`);
  }
  if (
    config.manifest.version !== version ||
    artifact.version !== version ||
    artifact.filename !== `${config.packageName}-${version}.tgz`
  ) {
    throw new Error(
      'Release reports must match both approved package versions.',
    );
  }
  const archive = readFileSync(path.join(reportDirectory, artifact.filename));
  const localIntegrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
  const registryIntegrity = JSON.parse(
    runCommand(
      getNpmCommand(),
      ['view', `${artifact.name}@${version}`, 'dist.integrity', '--json'],
      { cwd: REPO_ROOT },
    ),
  ) as unknown;
  if (
    registryIntegrity !== localIntegrity ||
    localIntegrity !== artifact.integrity
  ) {
    throw new Error(
      'GitHub assets must match both immutable registry artifacts.',
    );
  }
  files.push(
    artifact.filename,
    `${artifact.name}.cdx.json`,
    `${artifact.name}.licenses.json`,
  );
}
const endpoint = `repos/${githubRepo}/releases/tags/${encodeURIComponent(tag)}`;
const existing = spawnSync('gh', ['api', endpoint], {
  encoding: 'utf8',
  timeout: 60_000,
});
if (existing.error) throw existing.error;
let release: GithubRelease;
if (existing.status === 0) {
  release = JSON.parse(existing.stdout) as GithubRelease;
} else {
  if (!existing.stderr.includes('(HTTP 404)'))
    throw new Error('GitHub release lookup failed.');
  runCommand(
    'gh',
    [
      'release',
      'create',
      tag,
      '--repo',
      githubRepo,
      '--verify-tag',
      '--draft',
      '--title',
      tag,
      '--notes-file',
      path.join(reportDirectory, 'README.md'),
    ],
    { cwd: REPO_ROOT },
  );
  release = JSON.parse(
    runCommand('gh', ['api', endpoint], { cwd: REPO_ROOT }),
  ) as GithubRelease;
}
if (release.tag_name !== tag || !Array.isArray(release.assets))
  throw new Error('GitHub release identity is invalid.');
const temporaryDirectory = mkdtempSync(
  path.join(tmpdir(), 'limina-release-assets-'),
);
try {
  for (const filename of files) {
    const source = path.join(reportDirectory, filename);
    if (release.assets.some((asset) => asset.name === filename)) {
      const downloaded = path.join(temporaryDirectory, filename);
      runCommand(
        'gh',
        [
          'release',
          'download',
          tag,
          '--repo',
          githubRepo,
          '--pattern',
          filename,
          '--output',
          downloaded,
        ],
        { cwd: REPO_ROOT },
      );
      if (!readFileSync(downloaded).equals(readFileSync(source)))
        throw new Error(`Existing release asset differs: ${filename}`);
    } else {
      if (!release.draft)
        throw new Error(
          'Published GitHub releases cannot be repaired by silently adding assets.',
        );
      runCommand(
        'gh',
        ['release', 'upload', tag, source, '--repo', githubRepo],
        { cwd: REPO_ROOT },
      );
    }
  }
  if (release.draft)
    runCommand(
      'gh',
      [
        'release',
        'edit',
        tag,
        '--repo',
        githubRepo,
        '--draft=false',
        `--prerelease=${version.includes('-')}`,
      ],
      { cwd: REPO_ROOT },
    );
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
