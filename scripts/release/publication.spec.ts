import { collectBundledDependencies } from '@limina/build-tools/license-policy';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import {
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertNewReleaseTag } from './check-tag';
import { assertReleaseGroup } from './publication';
import {
  discoverReleasePackages,
  resolvePackageSelections,
  sortReleasePackageConfigs,
  type ReleasePlan,
} from './shared';

function plans(): ReleasePlan[] {
  return discoverReleasePackages().map((config) => ({
    config,
    currentVersion: config.manifest.version!,
    newVersion: config.manifest.version!,
    gitTag: `limina/v${config.manifest.version}`,
    npmTag: undefined,
  }));
}

it('rejects missing, conflicting and prohibited bundled license evidence', () => {
  assert.throws(
    () => collectBundledDependencies([{ name: 'fixture', version: '1.0.0' }]),
    /require/,
  );
  assert.throws(
    () =>
      collectBundledDependencies([
        { name: 'fixture', version: '1.0.0', license: 'GPL-3.0' },
      ]),
    /Prohibited/,
  );
  assert.throws(
    () =>
      collectBundledDependencies([
        { name: 'fixture', version: '1.0.0', license: 'MIT' },
        { name: 'fixture', version: '1.0.0', license: 'ISC' },
      ]),
    /Conflicting/,
  );
});

it('rejects imported tags and malformed selectors before release or deployment', () => {
  assert.equal(assertNewReleaseTag('limina/v1.2.3-beta.1'), '1.2.3-beta.1');
  assert.throws(() => assertNewReleaseTag('limina/v0.4.0'), /historical/);
  for (const tag of [
    'main',
    'other/v1.2.3',
    'limina/v1.2.3/../main',
    'limina/v1.2.3\n',
  ]) {
    assert.throws(() => assertNewReleaseTag(tag), /Expected/);
  }
});

describe('paired publication contract', () => {
  it('expands either package selector into dependency order', () => {
    const configs = discoverReleasePackages();
    for (const selector of ['limina', 'migrate', 'limina-migrate']) {
      assert.deepEqual(
        resolvePackageSelections([selector], configs).map(
          (config) => config.packageName,
        ),
        ['limina', 'limina-migrate'],
      );
    }
    assert.throws(
      () => resolvePackageSelections(['migrate'], configs.slice(1)),
      /complete, same-version/,
    );
    assert.deepEqual(
      sortReleasePackageConfigs(configs.toReversed()).map(
        (config) => config.packageName,
      ),
      ['limina', 'limina-migrate'],
    );
  });
  it('rejects incomplete, mixed-version and mixed-channel groups before publication', () => {
    assert.doesNotThrow(() => assertReleaseGroup(plans()));
    assert.throws(
      () => assertReleaseGroup(plans().slice(0, 1)),
      /both packages/,
    );
    const versions = plans();
    versions[1]!.newVersion = '99.0.0';
    assert.throws(() => assertReleaseGroup(versions), /one version/);
    const channels = plans();
    channels[1]!.npmTag = 'beta';
    assert.throws(() => assertReleaseGroup(channels), /one channel/);
  });
});

it('rejects leaked product dependencies, mismatched embedded sources and missing workers before publication', async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), 'limina-publication-contract-'),
  );
  const put = async (file: string, value: unknown) => {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
  };
  try {
    await put('package.json', { private: true, type: 'module' });
    const scripts = path.join(root, 'scripts/release');
    await mkdir(scripts, { recursive: true });
    for (const file of ['publication.ts', 'shared.ts', 'command.ts'])
      await copyFile(
        fileURLToPath(new URL(file, import.meta.url)),
        path.join(scripts, file),
      );
    // Only the fixture's release tooling uses these development dependencies.
    // Product source/dist inputs and their mutations are separate fixture data.
    // Resolve each package before linking so workspace-relative links keep
    // their physical roots when the fixture and repository use different drives.
    const repoNodeModules = fileURLToPath(
      new URL('../../node_modules/', import.meta.url),
    );
    for (const name of [
      '@limina/build-tools',
      'logaria',
      'prompts',
      'semver',
    ]) {
      const dependencyPath = path.join(root, 'node_modules', name);
      await mkdir(path.dirname(dependencyPath), { recursive: true });
      await symlink(
        await realpath(path.join(repoNodeModules, name)),
        dependencyPath,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
    const version = '1.2.0';
    for (const [directory, name] of [
      ['limina', 'limina'],
      ['migrate', 'limina-migrate'],
    ]) {
      const manifest = { name, version, publishConfig: { access: 'public' } };
      await put(`packages/${directory}/package.json`, manifest);
      await put(`packages/${directory}/dist/package.json`, manifest);
    }
    const build = {
      formatVersion: 1,
      coreVersion: version,
      migrateVersion: version,
    };
    const buildFile = 'packages/migrate/dist/migration-build.json';
    await put(buildFile, build);
    for (const resource of [
      'cli.js',
      'bin/limina-migrate.js',
      'migration-verify-process.js',
      'flow-renderer-process.js',
      'LICENSE.md',
      'bundled-dependencies.json',
    ])
      await put(`packages/migrate/dist/${resource}`, 'fixture');
    const publication = (await import(
      pathToFileURL(path.join(scripts, 'publication.ts')).href
    )) as typeof import('./publication');
    const shared = (await import(
      pathToFileURL(path.join(scripts, 'shared.ts')).href
    )) as typeof import('./shared');
    const configs = shared.discoverReleasePackages();
    const core = configs.find((config) => config.packageName === 'limina')!;
    const migrate = configs.find(
      (config) => config.packageName === 'limina-migrate',
    )!;
    const validate = () =>
      publication.validatePublicationTarget(
        migrate,
        version,
        `limina/v${version}`,
      );
    assert.doesNotThrow(validate);
    const manifestFile = 'packages/migrate/dist/package.json';
    const manifest = { name: 'limina-migrate', version };
    for (const section of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      await put(manifestFile, { ...manifest, [section]: { limina: version } });
      assert.throws(validate, /workspace-only dependency/u);
    }
    await put(manifestFile, {
      ...manifest,
      dependencies: { '@limina/core': version },
    });
    assert.throws(validate, /workspace-only dependency/u);
    await put(manifestFile, {
      ...manifest,
      dependencies: { tinyglobby: 'catalog:prod' },
    });
    assert.throws(validate, /workspace-only dependency/u);
    await put(manifestFile, manifest);
    for (const broken of [
      { ...build, coreVersion: '1.1.0' },
      { ...build, migrateVersion: '1.1.0' },
      { ...build, formatVersion: 99 },
    ]) {
      await put(buildFile, broken);
      assert.throws(validate, /same-release Limina source/u);
    }
    await put(buildFile, build);
    const coreSourceFile = 'packages/limina/package.json';
    await put(coreSourceFile, { name: 'limina', version: '1.1.0' });
    assert.throws(validate, /source and distribution versions/u);
    await put(coreSourceFile, { name: 'limina', version });
    const renderer = path.join(
      root,
      'packages/migrate/dist/flow-renderer-process.js',
    );
    await rename(renderer, `${renderer}.disabled`);
    assert.throws(validate, /resource is unavailable: flow-renderer-process/u);
    await rename(`${renderer}.disabled`, renderer);
    const buildPath = path.join(root, buildFile);
    await rename(buildPath, `${buildPath}.disabled`);
    assert.throws(validate, /migration-build\.json/u);
    await rename(`${buildPath}.disabled`, buildPath);
    await put('packages/limina/dist/package.json', {
      name: 'limina',
      version,
      exports: { './internal/migration': './internal/migration.js' },
    });
    assert.throws(
      () =>
        publication.validatePublicationTarget(
          core,
          version,
          `limina/v${version}`,
        ),
      /workspace-only internal support/u,
    );
    assert.doesNotThrow(validate);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

interface RegistryDocument {
  versions: Record<string, { dist: { integrity: string } }>;
  'dist-tags': Record<string, string>;
}

it(
  'holds the channel after a partial upload and retries only matching immutable artifacts',
  { timeout: 60_000 },
  async () => {
    const version = discoverReleasePackages()[0]!.manifest.version!;
    const documents = new Map<string, RegistryDocument>();
    const uploads: string[] = [];
    let promotions = 0;
    let isFailMigration = true;
    let isCorruptIntegrity = false;
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const url = new URL(request.url!, 'http://localhost');
      const parts = url.pathname.split('/');
      const isTagRequest = parts[1] === '-';
      const name = isTagRequest ? parts[3]! : parts[1]!;
      const reply = (status: number, value: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (request.method === 'PUT') {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (isTagRequest) {
          promotions++;
          documents.get(name)!['dist-tags'][parts[5]!] = body as string;
        } else {
          uploads.push(name);
          if (isFailMigration && name === 'limina-migrate') {
            reply(503, { error: 'controlled second upload failure' });
            return;
          }
          if (documents.has(name)) {
            reply(409, { error: 'immutable version already exists' });
            return;
          }
          documents.set(name, body as RegistryDocument);
        }
        reply(201, { ok: true });
        return;
      }
      const document = documents.get(name);
      if (!document) {
        reply(404, { error: 'not_found' });
        return;
      }
      const copy = structuredClone(document);
      if (isCorruptIntegrity && name === 'limina')
        copy.versions[version]!.dist.integrity = 'sha512-invalid';
      reply(200, isTagRequest ? copy['dist-tags'] : copy);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const directory = await mkdtemp(path.join(tmpdir(), 'limina-publication-'));
    const registry = `http://127.0.0.1:${address.port}`;
    const userconfig = path.join(directory, 'npmrc');
    await writeFile(
      userconfig,
      `//127.0.0.1:${address.port}/:_authToken=fixture-token\n`,
    );
    const source = `
    import { publishReleaseGroup } from ${JSON.stringify(new URL('publication.ts', import.meta.url).href)};
    import { discoverReleasePackages } from ${JSON.stringify(new URL('shared.ts', import.meta.url).href)};
    const plans = discoverReleasePackages().map(config => ({ config, currentVersion: config.manifest.version, newVersion: config.manifest.version, gitTag: 'limina/v' + config.manifest.version }));
    publishReleaseGroup(plans, { registry: ${JSON.stringify(registry)}, provenance: false });
  `;
    const run = () =>
      promisify(execFile)(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          '--input-type=module',
          '--eval',
          source,
        ],
        {
          timeout: 45_000,
          env: {
            ...process.env,
            npm_config_userconfig: userconfig,
            npm_config_cache: path.join(directory, 'cache'),
            npm_config_fetch_retries: '0',
          },
        },
      );
    try {
      await assert.rejects(run(), /controlled second upload failure/);
      assert.deepEqual(documents.keys().toArray(), ['limina']);
      assert.equal(promotions, 0);
      assert.equal(documents.get('limina')!['dist-tags'].latest, undefined);
      isFailMigration = false;
      await run();
      assert.deepEqual(uploads, ['limina', 'limina-migrate', 'limina-migrate']);
      assert.equal(promotions, 2);
      for (const document of documents.values())
        assert.equal(document['dist-tags'].latest, version);
      isCorruptIntegrity = true;
      await assert.rejects(run(), /Published artifact differs/);
      assert.equal(uploads.length, 3);
      assert.equal(promotions, 2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
