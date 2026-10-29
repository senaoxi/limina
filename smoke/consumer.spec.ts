import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertDistributionArtifacts,
  type ConsumerFixture,
  createConsumerFixture,
  getPeerDependencyRange,
  packLiminaDistribution,
  RELEASE_FIXTURE_PACKAGE_NAME,
  runNodeScript,
  runPnpm,
} from './helpers';

async function assertDefaultCheckWorkflow(
  fixture: ConsumerFixture,
): Promise<void> {
  const cwd = path.join(fixture.fixtureDir, 'default-workflow');
  await mkdir(path.join(cwd, 'src'), { recursive: true });
  await writeFile(
    path.join(cwd, 'package.json'),
    '{"name":"default-workflow","private":true,"type":"module"}',
  );
  await writeFile(path.join(cwd, 'src/index.ts'), 'export const value = 1;\n');
  await writeFile(
    path.join(cwd, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        composite: true,
        types: [],
        target: 'ES2022',
        module: 'NodeNext',
      },
      include: ['src/**/*.ts'],
    }),
  );
  const config = path.join(cwd, 'limina.config.mjs');
  for (const isFull of [true, false]) {
    await writeFile(
      config,
      `export default ${JSON.stringify(
        isFull
          ? {
              scope: { source: { include: ['src/**/*.ts'] } },
              graph: { rules: {} },
              source: { knip: false },
              proof: { allowlist: [] },
            }
          : { scope: { source: { include: ['src/**/*.ts'] } } },
      )};`,
    );
    await runPnpm(['exec', 'limina', 'check'], { cwd });
    const query = await runPnpm(
      ['exec', 'limina', 'check', '--issues', '--format', 'json'],
      { cwd },
    );
    const result = JSON.parse(query.stdout) as {
      run: { tasks: { kind: string; label: string; state: string }[] };
    };
    expect(
      result.run.tasks
        .filter((task) => task.kind === 'task')
        .map((task) => [task.label, task.state]),
    ).toEqual([
      ['graph:check', 'passed'],
      ['source:check', 'passed'],
      ['proof:check', 'passed'],
      ['checker:build', 'passed'],
      ['checker:typecheck', 'disabled'],
    ]);
  }
  for (const command of ['graph', 'source'])
    await runPnpm(['exec', 'limina', command, 'check'], { cwd });
  await runPnpm(['exec', 'limina', 'proof', 'check'], { cwd });
  await writeFile(
    path.join(cwd, 'uncovered.ts'),
    'export const uncovered = 1;\n',
  );
  await writeFile(config, 'export default {};');
  const empty = await runPnpm(['exec', 'limina', 'check'], {
    cwd,
    reject: false,
  });
  expect(empty.exitCode, empty.stdout + empty.stderr).toBe(1);
  const query = await runPnpm(
    ['exec', 'limina', 'check', '--issues', '--format', 'json'],
    { cwd },
  );
  const inventory = JSON.parse(query.stdout);
  expect(
    inventory.run.tasks
      .filter((task: { kind: string }) => task.kind === 'task')
      .map((task: { label: string }) => task.label),
  ).toEqual([
    'graph:check',
    'source:check',
    'proof:check',
    'checker:build',
    'checker:typecheck',
  ]);
  expect(inventory.issues).toContainEqual(
    expect.objectContaining({ code: 'LIMINA_PROOF_UNCOVERED_SOURCE_FILE' }),
  );
}

describe('limina published package smoke', () => {
  it('checks the Astro semantic graph with the lowest supported check version and TypeScript 5', async () => {
    const manifest = assertDistributionArtifacts();
    const packedDistribution = await packLiminaDistribution();
    let fixture: ConsumerFixture | undefined;

    try {
      fixture = await createConsumerFixture({
        astroSemanticFixture: true,
        astroToolchain: {
          checkVersion: '0.9.6',
          typeScriptVersion: '5.9.3',
        },
        manifest,
        tarballPath: packedDistribution.tarballPath,
      });
      const consumerManifest = JSON.parse(
        await readFile(path.join(fixture.fixtureDir, 'package.json'), 'utf8'),
      ) as { packageManager: string };
      const repoManifest = JSON.parse(
        await readFile(new URL('../package.json', import.meta.url), 'utf8'),
      ) as { packageManager: string };
      expect(consumerManifest.packageManager).toBe(repoManifest.packageManager);
      const rootRequire = createRequire(
        path.join(fixture.fixtureDir, 'package.json'),
      );
      const leafRequire = createRequire(
        path.join(fixture.fixtureDir, 'app/package.json'),
      );
      const checkManifestPath = leafRequire.resolve(
        '@astrojs/check/package.json',
      );
      const checkManifest = JSON.parse(
        await readFile(checkManifestPath, 'utf8'),
      ) as { version: string };
      const checkRequire = createRequire(checkManifestPath);
      const checkTypeScript = checkRequire('typescript') as { version: string };
      const rootTypeScript = rootRequire('typescript') as { version: string };
      expect(checkManifest.version).toBe('0.9.6');
      expect(checkTypeScript.version).toBe('5.9.3');
      expect(rootTypeScript.version).toBe('5.9.3');

      await writeFile(
        path.join(fixture.fixtureDir, 'app/src/Page.astro'),
        [
          '---',
          "import { value } from './index.ts';",
          'void value;',
          '---',
          '<h1>Minimum check version</h1>',
          '',
        ].join('\n'),
        'utf8',
      );
      const graphCheckResult = await runPnpm(
        ['exec', 'limina', '--config', './limina.config.mjs', 'graph', 'check'],
        { cwd: fixture.fixtureDir },
      );
      expect(graphCheckResult.stdout).toContain('limina graph passed');
    } finally {
      await fixture?.cleanup();
      await packedDistribution.cleanup();
    }
  });

  it('installs the packed package and exercises the public CLI surface', async () => {
    const manifest = assertDistributionArtifacts();
    const packedDistribution = await packLiminaDistribution();
    let fixture: ConsumerFixture | undefined;

    try {
      fixture = await createConsumerFixture({
        astroSemanticFixture: true,
        manifest,
        tarballPath: packedDistribution.tarballPath,
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
          '>=0.9.6 <0.10.0',
        );
        expect(
          packageManifest.peerDependenciesMeta?.['@astrojs/check']?.optional,
        ).toBe(true);
        for (const workspacePackageName of [
          '@limina/eslint-config',
          '@limina/gates',
          '@limina/build-tools',
          '@docs-islands/eslint-config',
          '@docs-islands/plugin-license',
          '@docs-islands/utils',
        ]) {
          expect(
            packageManifest.devDependencies?.[workspacePackageName],
          ).toBeUndefined();
        }
        expect(packageManifest.devDependencies?.logaria).toBe('^0.0.4');
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
      await assertDefaultCheckWorkflow(fixture);

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

      const releaseCheckArguments = [
        'exec',
        'limina',
        '--config',
        './limina.config.mjs',
        'release',
        'check',
        '--package',
        RELEASE_FIXTURE_PACKAGE_NAME,
      ];
      const releaseCheckResult = await runPnpm(releaseCheckArguments, {
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

      const invalidReleaseCheckResult = await runPnpm(releaseCheckArguments, {
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

      const missingPeerResult = await runPnpm(releaseCheckArguments, {
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

      const enabledReleaseCheckResult = await runPnpm(releaseCheckArguments, {
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
      await packedDistribution.cleanup();
    }
  });
});
