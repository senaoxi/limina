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
        astroSemanticFixture: true,
        manifest,
        tarballPath: packedDist.tarballPath,
      });

      const installedManifest = JSON.parse(
        await readFile(
          path.join(fixture.fixtureDir, 'node_modules/limina/package.json'),
          'utf8',
        ),
      ) as typeof manifest;
      expect(installedManifest.peerDependencies).toEqual(
        manifest.peerDependencies,
      );
      expect(installedManifest.devDependencies).toEqual(
        manifest.devDependencies,
      );
      expect(installedManifest.peerDependenciesMeta).toEqual(
        manifest.peerDependenciesMeta,
      );
      for (const packageManifest of [manifest, installedManifest]) {
        for (const section of [
          packageManifest.dependencies,
          packageManifest.devDependencies,
          packageManifest.optionalDependencies,
          packageManifest.peerDependencies,
          packageManifest.peerDependenciesMeta,
        ]) {
          expect(section?.['oxc-parser']).toBeUndefined();
          expect(section?.['@astrojs/compiler']).toBeUndefined();
        }
        for (const section of [
          packageManifest.dependencies,
          packageManifest.optionalDependencies,
          packageManifest.peerDependencies,
          packageManifest.peerDependenciesMeta,
        ]) {
          expect(section?.['@jridgewell/trace-mapping']).toBeUndefined();
        }
        expect(
          packageManifest.devDependencies?.['@jridgewell/trace-mapping'],
        ).toBe('^0.3.31');
        for (const section of [
          packageManifest.dependencies,
          packageManifest.optionalDependencies,
        ]) {
          expect(section?.svelte2tsx).toBeUndefined();
        }
        expect(packageManifest.devDependencies?.svelte2tsx).toBe('^0.7.61');
        expect(packageManifest.peerDependencies?.svelte2tsx).toBe('^0.7.61');
        expect(packageManifest.peerDependenciesMeta?.svelte2tsx?.optional).toBe(
          true,
        );
        expect(packageManifest.peerDependencies?.['@astrojs/check']).toBe(
          '0.9.10',
        );
        expect(
          packageManifest.peerDependenciesMeta?.['@astrojs/check']?.optional,
        ).toBe(true);
        for (const workspacePackageName of [
          '@docs-islands/eslint-config',
          '@docs-islands/plugin-license',
          '@docs-islands/utils',
        ]) {
          expect(
            packageManifest.devDependencies?.[workspacePackageName],
          ).toBeUndefined();
        }
        expect(packageManifest.devDependencies?.logaria).toBe('0.0.3');
      }
      expect(manifest.dependencies?.['oxc-resolver']).toBeDefined();
      expect(installedManifest.dependencies?.['oxc-resolver']).toBe(
        manifest.dependencies?.['oxc-resolver'],
      );
      for (const packageName of ['@vue/language-core', '@volar/typescript']) {
        expect(installedManifest.dependencies?.[packageName]).toBeUndefined();
        expect(
          installedManifest.devDependencies?.[packageName],
        ).toBeUndefined();
        expect(
          installedManifest.optionalDependencies?.[packageName],
        ).toBeUndefined();
        expect(
          installedManifest.peerDependencies?.[packageName],
        ).toBeUndefined();
        expect(
          installedManifest.peerDependenciesMeta?.[packageName],
        ).toBeUndefined();
      }

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

      await writeFile(
        path.join(fixture.fixtureDir, 'app/src/Page.astro'),
        [
          '---',
          "import { value } from './index.ts';",
          'void value;',
          '---',
          '<h1>Packed Astro owner</h1>',
          '',
        ].join('\n'),
        'utf8',
      );

      const rootConsumerManifest = JSON.parse(
        await readFile(path.join(fixture.fixtureDir, 'package.json'), 'utf8'),
      ) as { devDependencies?: Record<string, string> };
      const leafConsumerManifest = JSON.parse(
        await readFile(
          path.join(fixture.fixtureDir, 'app/package.json'),
          'utf8',
        ),
      ) as { devDependencies?: Record<string, string> };
      expect(rootConsumerManifest.devDependencies?.astro).toBeUndefined();
      expect(
        rootConsumerManifest.devDependencies?.['@astrojs/check'],
      ).toBeUndefined();
      expect(leafConsumerManifest.devDependencies).toMatchObject({
        '@astrojs/check': expect.any(String),
        astro: expect.any(String),
        typescript: expect.any(String),
      });

      const graphCheckResult = await runPnpm(
        ['exec', 'limina', '--config', './limina.config.mjs', 'graph', 'check'],
        { cwd: fixture.fixtureDir },
      );

      expect(graphCheckResult.stdout).toContain('limina graph check');
      expect(graphCheckResult.stdout).toContain('limina graph passed');

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
      expect(missingPeerOutput).toContain('Missing Limina runtime dependency:');
      expect(missingPeerOutput).toContain('package: npm-package-json-lint');

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
