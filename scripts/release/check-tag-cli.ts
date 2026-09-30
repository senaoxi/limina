import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assertNewReleaseTag } from './check-tag';
import {
  discoverReleasePackages,
  getGitCommand,
  ReleaseLogger,
  REPO_ROOT,
  runCommand,
} from './shared';

const tag = process.env.RELEASE_TAG ?? '';
const historicalTags = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'migration/original-tags.json'), 'utf8'),
) as Record<string, string>;
const version = assertNewReleaseTag(tag, Object.keys(historicalTags));
const packages = discoverReleasePackages();
if (packages.some((config) => config.manifest.version !== version)) {
  throw new Error('The release tag must match both source package versions.');
}
const commit = runCommand(
  getGitCommand(),
  ['rev-parse', '--verify', `refs/tags/${tag}^0`],
  { cwd: REPO_ROOT },
).trim();
const head = runCommand(getGitCommand(), ['rev-parse', 'HEAD'], {
  cwd: REPO_ROOT,
}).trim();
if (commit !== head)
  throw new Error('Checkout must be the exact approved tagged commit.');
runCommand(
  getGitCommand(),
  ['merge-base', '--is-ancestor', commit, 'refs/remotes/origin/main'],
  { cwd: REPO_ROOT },
);
ReleaseLogger.info(
  `Approved tag shape and source group: ${tag}. Remote CI and cutover approval remain separate gates.`,
);
