import { assertNewReleaseTag } from './check-tag.ts';
import {
  discoverReleasePackages,
  getGitCommand,
  ReleaseLogger,
  REPO_ROOT,
  runCommand,
} from './shared.ts';

const tag = process.env.RELEASE_TAG ?? '';
const version = assertNewReleaseTag(tag);
const packages = discoverReleasePackages();
if (
  packages.length !== 2 ||
  packages.some(
    (config) =>
      config.manifest.name !== config.packageName ||
      config.manifest.version !== version,
  )
) {
  throw new Error(
    'The release tag must match both source package names and versions with public access.',
  );
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
