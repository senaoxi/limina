import path from 'node:path';
import semver from 'semver';
import { execReleaseCommand } from './command';
import { validatePublicationTarget } from './publication';
import { runPublishCommand } from './release';
import { discoverReleasePackages, REPO_ROOT } from './shared';

if (
  !semver.satisfies(
    execReleaseCommand('npm', ['--version'], { encoding: 'utf8' }).trim(),
    '^11.21.0 || >=12.2.0',
  )
)
  throw new Error(
    'npm ^11.21.0 or >=12.2.0 is required for trusted publication and dist-tag updates',
  );

const tag = process.env.RELEASE_TAG;
const configs = discoverReleasePackages();
for (const config of configs) {
  validatePublicationTarget(config, config.manifest.version ?? '', tag ?? '');
}
await runPublishCommand({
  packageSelectors: ['limina'],
  dryRun: false,
  skipTests: true,
  skipBuild: true,
  provenance: true,
  evidenceDirectory: path.join(REPO_ROOT, '.reports/release/npm'),
  help: false,
});
