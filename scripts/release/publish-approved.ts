import { execFileSync } from 'node:child_process';
import semver from 'semver';
import { validatePublicationTarget } from './publication';
import { runPublishCommand } from './release';
import { discoverReleasePackages } from './shared';

if (
  semver.lt(
    execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
    '11.5.2',
  )
)
  throw new Error('npm 11.5.2 or newer is required for trusted publishing');

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
  help: false,
});
