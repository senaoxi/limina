import { collectBundledDependencies } from '@limina/gates/license-policy';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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
import { installGatesFixture } from '../gates-fixture';

import { assertNewReleaseTag } from '@limina/gates/release/check-tag';
import { assertReleaseGroup } from '@limina/gates/release/publication';
import {
  discoverReleasePackages,
  resolvePackageSelections,
  sortReleasePackageConfigs,
  type ReleasePlan,
} from '@limina/gates/release/shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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

async function createLicensePolicyFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'limina-license-policy-'));
  const modulePath = path.join(root, 'packages/gates/dist/license-policy.js');
  const policyPath = path.join(root, '.agents/docs/license-policy.md');
  await mkdir(path.dirname(modulePath), { recursive: true });
  await mkdir(path.dirname(policyPath), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
  for (const file of ['license-policy.js', 'licenses.js']) {
    await copyFile(
      fileURLToPath(
        new URL(`../../packages/gates/dist/${file}`, import.meta.url),
      ),
      path.join(path.dirname(modulePath), file),
    );
  }
  const markedPath = path.join(root, 'node_modules/marked');
  const markedSource = fileURLToPath(
    new URL('../../packages/gates/node_modules/marked', import.meta.url),
  );
  await mkdir(path.dirname(markedPath), { recursive: true });
  await symlink(
    await realpath(markedSource),
    markedPath,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  return {
    writePolicy(markdown: string) {
      return writeFile(policyPath, markdown);
    },
    async run(licenses: string[]): Promise<unknown> {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `
            import { collectBundledDependencies } from ${JSON.stringify(pathToFileURL(modulePath).href)};
            const dependencies = JSON.parse(process.argv[1]).map((license, index) => ({
              name: 'fixture-' + index, version: '1.0.0', license,
            }));
            process.stdout.write(JSON.stringify(collectBundledDependencies(dependencies)));
          `,
          JSON.stringify(licenses),
        ],
        { cwd: tmpdir() },
      );
      return JSON.parse(stdout);
    },
    close() {
      return rm(root, { recursive: true, force: true });
    },
  };
}

describe('Markdown license policy', () => {
  it('uses edited policy data from another working directory across Markdown fence forms', async () => {
    const fixture = await createLicensePolicyFixture();
    const policy =
      '# Policy\n\n```text\nGPL-3.0\n```\n\n```json\n["Zlib", "ISC"]\n```\n';
    try {
      for (const markdown of [
        policy,
        policy.replaceAll('\n', '\r\n'),
        '~~~json\n["Zlib", "ISC"]\n~~~\n',
        '````text\n```json\n["GPL-3.0"]\n```\n````\n\n```json\n["Zlib", "ISC"]\n```\n',
      ]) {
        await fixture.writePolicy(markdown);
        assert.deepEqual(await fixture.run(['Zlib', 'ISC']), [
          { name: 'fixture-0', version: '1.0.0', license: 'Zlib' },
          { name: 'fixture-1', version: '1.0.0', license: 'ISC' },
        ]);
        await assert.rejects(fixture.run(['MIT']), /Prohibited.*MIT/u);
      }
      await fixture.writePolicy('```json\n["MIT"]\n```\n');
      await assert.rejects(fixture.run(['Zlib']), /Prohibited.*Zlib/u);
      assert.deepEqual(await fixture.run(['MIT']), [
        { name: 'fixture-0', version: '1.0.0', license: 'MIT' },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it('stops on missing, ambiguous or invalid policy data without a fallback list', async () => {
    const fixture = await createLicensePolicyFixture();
    try {
      await assert.rejects(fixture.run(['MIT']), /ENOENT/u);
      for (const markdown of [
        '# No license data\n',
        '> ```json\n> ["MIT"]\n> ```\n',
        '```text\n["MIT"]\n```\n',
        '```json\n["MIT"]\n```\n```json\n["ISC"]\n```\n',
      ]) {
        await fixture.writePolicy(markdown);
        await assert.rejects(
          fixture.run(['MIT']),
          /exactly one JSON code block/u,
        );
      }
      await fixture.writePolicy('```json\n["MIT",]\n```\n');
      await assert.rejects(fixture.run(['MIT']), /SyntaxError/u);
      for (const value of [[], {}, [''], [' MIT'], ['MIT', 'MIT'], [1]]) {
        await fixture.writePolicy(
          `\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`,
        );
        await assert.rejects(
          fixture.run(['MIT']),
          /non-empty array of unique/u,
        );
      }
    } finally {
      await fixture.close();
    }
  });
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
    installGatesFixture(root);
    const scripts = path.join(root, 'packages/gates/src/release');
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
    )) as typeof import('@limina/gates/release/publication');
    const shared = (await import(
      pathToFileURL(path.join(scripts, 'shared.ts')).href
    )) as typeof import('@limina/gates/release/shared');
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

async function createPublicationFixture(npmTag = 'beta') {
  const version = discoverReleasePackages()[0]!.manifest.version!;
  const documents = new Map<string, RegistryDocument>();
  const uploads: string[] = [];
  let promotions = 0;
  const metadataMissingPromotions: number[] = [];
  const controls = {
    isFailMigration: false,
    isCorruptIntegrity: false,
    isFailPromotion: false,
    isDropPromotion: false,
    isLoseUploadResponse: false,
    metadataMisses: new Map<string, number>(),
    bootstrapLatest: new Map<string, string>(),
    isChangeLatest: false,
  };
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
        if (name === 'limina-migrate' && controls.isFailPromotion) {
          reply(503, { error: 'controlled second promotion failure' });
          return;
        }
        if (!(name === 'limina-migrate' && controls.isDropPromotion))
          documents.get(name)!['dist-tags'][parts[5]!] = body as string;
        if (name === 'limina-migrate' && controls.isChangeLatest)
          documents.get(name)!['dist-tags'].latest = version;
      } else {
        uploads.push(name);
        if (name === 'limina-migrate' && controls.isFailMigration) {
          reply(503, { error: 'controlled second upload failure' });
          return;
        }
        if (documents.has(name)) {
          reply(409, { error: 'immutable version already exists' });
          return;
        }
        documents.set(name, body as RegistryDocument);
        const bootstrapLatest = controls.bootstrapLatest.get(name);
        if (bootstrapLatest !== undefined)
          documents.get(name)!['dist-tags'].latest = bootstrapLatest;
        if (name === 'limina-migrate' && controls.isLoseUploadResponse) {
          reply(503, {
            error: 'controlled response failure after accepted upload',
          });
          return;
        }
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
    const misses = controls.metadataMisses.get(name) ?? 0;
    if (!isTagRequest && misses > 0) {
      controls.metadataMisses.set(name, misses - 1);
      metadataMissingPromotions.push(promotions);
      delete copy.versions[version];
    }
    if (name === 'limina' && controls.isCorruptIntegrity)
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
    import { publishReleaseGroup } from ${JSON.stringify(new URL('../../packages/gates/src/release/publication.ts', import.meta.url).href)};
    import { discoverReleasePackages } from ${JSON.stringify(new URL('../../packages/gates/src/release/shared.ts', import.meta.url).href)};
    const plans = discoverReleasePackages().map(config => ({ config, currentVersion: config.manifest.version, newVersion: config.manifest.version, gitTag: 'limina/v' + config.manifest.version, npmTag: ${JSON.stringify(npmTag)} }));
    publishReleaseGroup(plans, { registry: ${JSON.stringify(registry)}, provenance: false, evidenceDirectory: ${JSON.stringify(path.join(directory, 'evidence'))} });
  `;
  const run = (isFastVisibilityTimeout = false) =>
    promisify(execFile)(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        '--input-type=module',
        '--eval',
        // Keep real npm/HTTP behavior, but advance the publication clock without
        // sleeping. Four five-second polls otherwise exhaust Windows' process
        // budget after packing and starting npm. The timeout control still
        // advances beyond the production deadline and must refuse promotion.
        `
            import { mock } from 'node:test';
            import { performance } from 'node:perf_hooks';
            let elapsed = 0;
            mock.method(performance, 'now', () => elapsed);
            mock.method(Atomics, 'wait', (_buffer, _index, _value, milliseconds) => {
              elapsed += ${isFastVisibilityTimeout ? 3_600_000 : 'milliseconds ?? 0'};
              return 'timed-out';
            });
            ${source}
          `,
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
  const readEvidence = async () => {
    const evidenceDirectories = await readdir(path.join(directory, 'evidence'));
    return Promise.all(
      evidenceDirectories.map(async (name) => {
        const attempt = path.join(directory, 'evidence', name);
        const state = JSON.parse(
          await readFile(path.join(attempt, 'publication.json'), 'utf8'),
        );
        for (const member of state.packages) {
          assert.match(member.integrity, /^sha512-/u);
          const bytes = await readFile(path.join(attempt, member.filename));
          const integrity = createHash('sha512').update(bytes).digest('base64');
          assert.equal(member.integrity, `sha512-${integrity}`);
        }
        return state;
      }),
    );
  };
  return {
    version,
    documents,
    uploads,
    controls,
    metadataMissingPromotions,
    get promotions() {
      return promotions;
    },
    run,
    readEvidence,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it('rejects invalid channels before uploading either member', async () => {
  for (const tag of ['0.5.0-beta.2', '>=0.5', '1', 'beta next']) {
    const fixture = await createPublicationFixture(tag);
    try {
      await assert.rejects(fixture.run(), /Invalid npm tag/u);
      assert.equal(fixture.documents.size, 0);
      assert.deepEqual(fixture.uploads, []);
      assert.equal(fixture.promotions, 0);
    } finally {
      await fixture.close();
    }
  }
});

// Each fault owns a fresh registry and the existing 60-second case budget.
// One serial case exceeded that budget on Windows after recovery coverage grew.
it(
  'holds the channel after a partial upload and retries only matching immutable artifacts',
  { timeout: 60_000 },
  async () => {
    const fixture = await createPublicationFixture();
    try {
      fixture.controls.isFailMigration = true;
      await assert.rejects(fixture.run(), /controlled second upload failure/);
      assert.deepEqual(fixture.documents.keys().toArray(), ['limina']);
      assert.equal(fixture.promotions, 0);
      assert.equal(
        fixture.documents.get('limina')!['dist-tags'].beta,
        undefined,
      );
      assert.equal(
        fixture.documents.get('limina')!['dist-tags'].latest,
        undefined,
      );
      fixture.controls.isFailMigration = false;
      await fixture.run();
      assert.deepEqual(fixture.uploads, [
        'limina',
        'limina-migrate',
        'limina-migrate',
      ]);
      assert.equal(fixture.promotions, 2);
      for (const document of fixture.documents.values())
        assert.equal(document['dist-tags'].beta, fixture.version);
      const evidence = await fixture.readEvidence();
      assert.deepEqual(
        evidence
          .map((state) => state.status)
          .sort((left, right) => left.localeCompare(right)),
        ['complete', 'failed'],
      );
      const failed = evidence.find((state) => state.status === 'failed');
      assert.equal(
        failed.packages[0].registryIntegrity.startsWith('sha512-'),
        true,
      );
      assert.equal(failed.packages[1].registryIntegrity, null);
      fixture.controls.isCorruptIntegrity = true;
      await assert.rejects(fixture.run(), /Published artifact differs/);
      assert.equal(fixture.uploads.length, 3);
      assert.equal(fixture.promotions, 2);
    } finally {
      await fixture.close();
    }
  },
);

it(
  'repairs a split beta channel without reuploading versions or changing latest',
  { timeout: 60_000 },
  async () => {
    const fixture = await createPublicationFixture();
    try {
      await fixture.run();
      for (const document of fixture.documents.values()) {
        document['dist-tags'].latest = '0.3.0';
        delete document['dist-tags'].beta;
      }
      fixture.controls.isFailPromotion = true;
      await assert.rejects(
        fixture.run(),
        /controlled second promotion failure/,
      );
      assert.equal(
        fixture.documents.get('limina')!['dist-tags'].beta,
        fixture.version,
      );
      assert.equal(
        fixture.documents.get('limina-migrate')!['dist-tags'].beta,
        undefined,
      );
      const evidence = await fixture.readEvidence();
      const failed = evidence.find((state) => state.status === 'failed');
      assert.equal(failed.phase, 'promote');
      assert.equal(failed.packages[0].tagsAfter.beta, fixture.version);
      assert.equal(failed.packages[1].tagsAfter.beta, undefined);
      fixture.controls.isFailPromotion = false;
      await fixture.run();
      assert.deepEqual(fixture.uploads, ['limina', 'limina-migrate']);
      for (const document of fixture.documents.values()) {
        assert.equal(document['dist-tags'].beta, fixture.version);
        assert.equal(document['dist-tags'].latest, '0.3.0');
      }
    } finally {
      await fixture.close();
    }
  },
);

it(
  'rejects an acknowledged promotion until the actual channel is verified',
  { timeout: 60_000 },
  async () => {
    const fixture = await createPublicationFixture();
    try {
      fixture.controls.isDropPromotion = true;
      await assert.rejects(fixture.run(), /Channel verification failed/u);
      assert.equal(fixture.documents.size, 2);
      assert.equal(
        fixture.documents.get('limina-migrate')!['dist-tags'].beta,
        undefined,
      );
      fixture.controls.isDropPromotion = false;
      await fixture.run();
      assert.deepEqual(fixture.uploads, ['limina', 'limina-migrate']);
      for (const document of fixture.documents.values())
        assert.equal(document['dist-tags'].beta, fixture.version);
    } finally {
      await fixture.close();
    }
  },
);

it(
  'records accepted uploads after a failed response and retries without overwriting them',
  { timeout: 60_000 },
  async () => {
    const fixture = await createPublicationFixture();
    try {
      fixture.controls.isLoseUploadResponse = true;
      await assert.rejects(
        fixture.run(),
        /controlled response failure after accepted upload/u,
      );
      assert.equal(fixture.documents.size, 2);
      assert.equal(fixture.promotions, 0);
      const evidence = await fixture.readEvidence();
      const failed = evidence.find((state) => state.status === 'failed');
      assert.equal(failed.phase, 'upload');
      for (const member of failed.packages)
        assert.equal(member.registryIntegrity, member.integrity);
      fixture.controls.isLoseUploadResponse = false;
      await fixture.run();
      assert.deepEqual(fixture.uploads, ['limina', 'limina-migrate']);
      for (const document of fixture.documents.values())
        assert.equal(document['dist-tags'].beta, fixture.version);
    } finally {
      await fixture.close();
    }
  },
);

it(
  'waits for both accepted versions to become visible before promoting the channel',
  { timeout: 60_000 },
  async () => {
    const fixture = await createPublicationFixture();
    try {
      fixture.controls.metadataMisses.set('limina', 2);
      fixture.controls.metadataMisses.set('limina-migrate', 2);
      await fixture.run();
      assert.deepEqual(fixture.uploads, ['limina', 'limina-migrate']);
      assert.deepEqual(fixture.metadataMissingPromotions, [0, 0, 0, 0]);
      assert.equal(fixture.promotions, 2);
      for (const document of fixture.documents.values()) {
        assert.equal(document['dist-tags'].beta, fixture.version);
        assert.equal(document['dist-tags'].latest, undefined);
      }
      const [evidence] = await fixture.readEvidence();
      assert.equal(evidence.status, 'complete');
      for (const member of evidence.packages)
        assert.equal(member.registryIntegrity, member.integrity);
    } finally {
      await fixture.close();
    }
  },
);

it(
  'fails without promoting when an accepted version stays invisible past the deadline',
  { timeout: 60_000 },
  async () => {
    const fixture = await createPublicationFixture();
    try {
      fixture.controls.metadataMisses.set('limina', Infinity);
      await assert.rejects(
        fixture.run(true),
        /Published version did not become visible within five minutes/u,
      );
      assert.deepEqual(fixture.uploads, ['limina']);
      assert.equal(fixture.promotions, 0);
      const [evidence] = await fixture.readEvidence();
      assert.equal(evidence.status, 'failed');
      assert.equal(evidence.phase, 'upload');
      assert.equal(evidence.packages[0].registryIntegrity, null);
    } finally {
      await fixture.close();
    }
  },
);

it(
  'accepts registry bootstrap latest for previously missing packages',
  { timeout: 60_000 },
  async () => {
    const fixture = await createPublicationFixture();
    try {
      for (const name of ['limina', 'limina-migrate'])
        fixture.controls.bootstrapLatest.set(name, fixture.version);
      await fixture.run();
      assert.deepEqual(fixture.uploads, ['limina', 'limina-migrate']);
      const [evidence] = await fixture.readEvidence();
      assert.equal(evidence.status, 'complete');
      for (const member of evidence.packages) {
        assert.deepEqual(member.tagsBefore, {});
        assert.equal(member.tagsAfter.beta, fixture.version);
        assert.equal(member.tagsAfter.latest, fixture.version);
      }
    } finally {
      await fixture.close();
    }
  },
);

it(
  'rejects an unrelated latest during registry bootstrap',
  { timeout: 60_000 },
  async () => {
    const fixture = await createPublicationFixture();
    try {
      fixture.controls.bootstrapLatest.set('limina-migrate', '9.9.0');
      await assert.rejects(
        fixture.run(),
        /Latest channel changed for limina-migrate/u,
      );
      const [evidence] = await fixture.readEvidence();
      assert.equal(evidence.status, 'failed');
      assert.equal(evidence.phase, 'verify-channels');
      assert.equal(evidence.packages[1].tagsAfter.beta, fixture.version);
      assert.equal(evidence.packages[1].tagsAfter.latest, '9.9.0');
    } finally {
      await fixture.close();
    }
  },
);

it(
  'preserves an existing latest even when registry changes it to the candidate',
  { timeout: 60_000 },
  async () => {
    const fixture = await createPublicationFixture();
    try {
      await fixture.run();
      for (const document of fixture.documents.values()) {
        document['dist-tags'].latest = '0.3.0';
        document['dist-tags'].beta = '0.3.0';
      }
      fixture.controls.isChangeLatest = true;
      await assert.rejects(
        fixture.run(),
        /Latest channel changed for limina-migrate/u,
      );
      assert.deepEqual(fixture.uploads, ['limina', 'limina-migrate']);
      const evidence = await fixture.readEvidence();
      const failed = evidence.find((state) => state.status === 'failed');
      assert.equal(failed.phase, 'verify-channels');
      assert.equal(failed.packages[1].tagsBefore.latest, '0.3.0');
      assert.equal(failed.packages[1].tagsAfter.latest, fixture.version);
    } finally {
      await fixture.close();
    }
  },
);
