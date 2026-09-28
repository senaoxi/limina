import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertReleaseGroup } from './publication';
import {
  discoverReleasePackages,
  resolvePackageSelections,
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
    let failMigration = true;
    let corruptIntegrity = false;
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const url = new URL(request.url!, 'http://localhost');
      const parts = url.pathname.split('/');
      const tagRequest = parts[1] === '-';
      const name = tagRequest ? parts[3]! : parts[1]!;
      const reply = (status: number, value: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (request.method === 'PUT') {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (tagRequest) {
          promotions++;
          documents.get(name)!['dist-tags'][parts[5]!] = body as string;
        } else {
          uploads.push(name);
          if (failMigration && name === 'limina-migrate') {
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
      if (corruptIntegrity && name === 'limina')
        copy.versions[version]!.dist.integrity = 'sha512-invalid';
      reply(200, tagRequest ? copy['dist-tags'] : copy);
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
      assert.deepEqual([...documents.keys()], ['limina']);
      assert.equal(promotions, 0);
      assert.equal(documents.get('limina')!['dist-tags'].latest, undefined);
      failMigration = false;
      await run();
      assert.deepEqual(uploads, ['limina', 'limina-migrate', 'limina-migrate']);
      assert.equal(promotions, 2);
      for (const document of documents.values())
        assert.equal(document['dist-tags'].latest, version);
      corruptIntegrity = true;
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
