import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertDistArtifacts,
  type ConsumerFixture,
  createConsumerFixture,
  getPeerDependencyRange,
  packLiminaDist,
  RELEASE_FIXTURE_PACKAGE_NAME,
  runNodeScript,
  runPnpm,
} from './helpers';

describe('limina published package smoke', () => {
  it('installs the packed package and exercises the public CLI surface', async () => {
    const manifest = assertDistArtifacts();
    const packedDist = await packLiminaDist();
    let fixture: ConsumerFixture | undefined;

    try {
      fixture = await createConsumerFixture({
        manifest,
        tarballPath: packedDist.tarballPath,
      });

      const helpResult = await runPnpm(['exec', 'limina', '--help'], {
        cwd: fixture.fixtureDir,
      });

      expect(helpResult.stdout).toContain('Usage:');
      expect(helpResult.stdout).toContain('$ limina <command> [options]');

      const exportsResult = await runNodeScript({
        cwd: fixture.fixtureDir,
        scriptPath: path.join(fixture.fixtureDir, 'verify-exports.mjs'),
      });

      expect(exportsResult.stdout).toContain('limina exports ok');

      const sourceCheckResult = await runPnpm(
        [
          'exec',
          'limina',
          '--config',
          './limina.config.mjs',
          'source',
          'check',
        ],
        {
          cwd: fixture.fixtureDir,
        },
      );

      expect(sourceCheckResult.stdout).toContain('limina source check');
      expect(sourceCheckResult.stdout).toContain('limina source passed');

      const releaseCheckArgs = [
        'exec',
        'limina',
        '--config',
        './limina.config.mjs',
        'release',
        'check',
        '--package',
        RELEASE_FIXTURE_PACKAGE_NAME,
      ];
      const releaseCheckResult = await runPnpm(releaseCheckArgs, {
        cwd: fixture.fixtureDir,
      });

      expect(releaseCheckResult.stdout).toContain('limina release check');
      expect(releaseCheckResult.stdout).toContain('release checks passed');

      const releaseManifestPath = path.join(
        fixture.fixtureDir,
        'release-dist',
        'package.json',
      );
      const releaseManifest = JSON.parse(
        await readFile(releaseManifestPath, 'utf8'),
      ) as Record<string, unknown>;

      delete releaseManifest.types;
      await writeFile(
        releaseManifestPath,
        `${JSON.stringify(releaseManifest, null, 2)}\n`,
        'utf8',
      );

      const invalidReleaseCheckResult = await runPnpm(releaseCheckArgs, {
        cwd: fixture.fixtureDir,
        reject: false,
      });

      expect(invalidReleaseCheckResult.exitCode).toBe(0);

      const configSource = await readFile(fixture.configPath, 'utf8');

      await writeFile(
        fixture.configPath,
        configSource.replace(
          '  package: {',
          '  release: { npmPackageJsonLint: true },\n  package: {',
        ),
        'utf8',
      );

      const missingPeerResult = await runPnpm(releaseCheckArgs, {
        cwd: fixture.fixtureDir,
        reject: false,
      });
      const missingPeerOutput = `${missingPeerResult.stdout}\n${missingPeerResult.stderr}`;

      expect(missingPeerResult.exitCode).toBe(1);
      expect(missingPeerOutput).toContain(
        'Missing peer dependency "npm-package-json-lint"',
      );

      await runPnpm(
        [
          'add',
          '--save-dev',
          '--prefer-offline',
          '--ignore-scripts',
          `npm-package-json-lint@${getPeerDependencyRange(
            manifest,
            'npm-package-json-lint',
          )}`,
        ],
        {
          cwd: fixture.fixtureDir,
          inherit: true,
          timeout: 300_000,
        },
      );

      const enabledReleaseCheckResult = await runPnpm(releaseCheckArgs, {
        cwd: fixture.fixtureDir,
        reject: false,
      });
      const invalidReleaseOutput = `${enabledReleaseCheckResult.stdout}\n${enabledReleaseCheckResult.stderr}`;

      expect(enabledReleaseCheckResult.exitCode).toBe(1);
      expect(invalidReleaseOutput).toContain(
        'Packed package manifest failed npm-package-json-lint',
      );
      expect(invalidReleaseOutput).toContain('require-types');
      expect(invalidReleaseOutput).not.toContain('ReferenceError');
    } finally {
      if (fixture) {
        await fixture.cleanup();
      }
      await packedDist.cleanup();
    }
  });
});
