import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReleaseConsistencyState } from '../package-check/release/consistency/dependencies';
import { loadReleaseRegistryConfiguration } from '../package-check/release/registry/configuration';
import { fetchRegistryPackageMetadata } from '../package-check/release/registry/metadata';
import { fetchRegistryTarball } from '../package-check/release/registry/tarball';
import { createFixturePathResolver } from './helpers/path';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'limina-registry-'));
  directories.push(root);
  const resolve = createFixturePathResolver(root);
  await writeFile(resolve('package.json'), '{}');
  await writeFile(resolve('user.npmrc'), '');
  await writeFile(resolve('global.npmrc'), '');
  const environment = {
    HOME: root,
    NPM_CONFIG_USERCONFIG: resolve('user.npmrc'),
    NPM_CONFIG_GLOBALCONFIG: resolve('global.npmrc'),
  };
  return { rootDir: resolve(), path: resolve, environment };
}

describe('effective release registry authority', () => {
  it('ignores empty environment settings and interpolates npmrc keys', async () => {
    const f = await fixture();
    await writeFile(
      f.path('.npmrc'),
      'registry=https://project.example/\n@${SCOPE}:registry=https://scope.example/',
    );
    const snapshot = loadReleaseRegistryConfiguration(f.rootDir, {
      ...f.environment,
      SCOPE: 'team',
      NPM_CONFIG_REGISTRY: '',
      npm_config_userconfig: '',
    });
    expect(snapshot.authorityFor('pkg').baseUrl).toBe(
      'https://project.example/',
    );
    expect(snapshot.authorityFor('@team/pkg').baseUrl).toBe(
      'https://scope.example/',
    );
    expect(() =>
      loadReleaseRegistryConfiguration(f.rootDir, f.environment),
    ).toThrow(/environment variable SCOPE is not defined/u);
  });

  it('expands home-relative configuration paths using platform syntax', async () => {
    const f = await fixture();
    await writeFile(f.path('user.npmrc'), 'registry=https://home.example/');
    const prefix = process.platform === 'win32' ? '~\\' : '~/';
    const snapshot = loadReleaseRegistryConfiguration(f.rootDir, {
      ...f.environment,
      NPM_CONFIG_USERCONFIG: `${prefix}user.npmrc`,
    });
    expect(snapshot.authorityFor('pkg').baseUrl).toBe('https://home.example/');
  });

  it.each([
    [['packages/**', '!packages/private/**'], 'leaf'],
    [['packages/**', '!packages/private/**', 'packages/private/a'], 'root'],
    [['packages/**', '!packages/private'], 'root'],
  ] as const)(
    'locates npm workspace configuration for %j',
    async (patterns, host) => {
      const f = await fixture();
      await mkdir(f.path('packages/private/a'), { recursive: true });
      await writeFile(
        f.path('package.json'),
        JSON.stringify({ workspaces: patterns }),
      );
      await writeFile(
        f.path('packages/private/a/package.json'),
        '{"name":"a"}',
      );
      await writeFile(f.path('.npmrc'), 'registry=https://root.example/');
      await writeFile(
        f.path('packages/private/a/.npmrc'),
        'registry=https://leaf.example/',
      );
      const snapshot = loadReleaseRegistryConfiguration(
        f.path('packages/private/a'),
        f.environment,
      );
      expect(snapshot.authorityFor('pkg').baseUrl).toBe(
        `https://${host}.example/`,
      );
    },
  );

  it('merges each key before selecting a scope and snapshots files and environment', async () => {
    const f = await fixture();
    await writeFile(
      f.path('global.npmrc'),
      'registry=https://global.example/\n@global:registry=https://global.example/scope/',
    );
    await writeFile(
      f.path('user.npmrc'),
      'registry=https://user.example/\n@team:registry=https://user.example/team/',
    );
    await writeFile(
      f.path('.npmrc'),
      '# comment\nregistry="https://project.example/npm/"\n@team:registry="https://${HOST}/team/"\n@project:registry=https://project.example/scoped/ ; comment',
    );
    const environment = {
      ...f.environment,
      HOST: 'corp.example',
      NPM_CONFIG_REGISTRY: 'https://upper.example/',
      npm_config_registry: 'https://lower.example/',
    };
    const snapshot = loadReleaseRegistryConfiguration(f.rootDir, environment);
    expect(snapshot.authorityFor('@team/a').baseUrl).toBe(
      'https://corp.example/team/',
    );
    expect(snapshot.authorityFor('@project/a').baseUrl).toBe(
      'https://project.example/scoped/',
    );
    expect(snapshot.authorityFor('@global/a').baseUrl).toBe(
      'https://global.example/scope/',
    );
    expect(snapshot.authorityFor('plain').baseUrl).toBe(
      'https://lower.example/',
    );
    environment.HOST = 'changed.example';
    environment.npm_config_registry = 'http://localhost/';
    await writeFile(f.path('.npmrc'), 'registry=https://changed.example/');
    expect(snapshot.authorityFor('@team/b').baseUrl).toBe(
      'https://corp.example/team/',
    );
    expect(snapshot.authorityFor('plain').baseUrl).toBe(
      'https://lower.example/',
    );
  });

  it('finds the npm workspace from the command cwd and preserves registry paths in requests and caches', async () => {
    const f = await fixture();
    await mkdir(f.path('packages/a/src'), { recursive: true });
    await writeFile(
      f.path('package.json'),
      JSON.stringify({ workspaces: ['packages/*'] }),
    );
    await writeFile(f.path('packages/a/package.json'), '{}');
    await writeFile(
      f.path('packages/a/.npmrc'),
      'registry=https://wrong.example/',
    );
    await writeFile(f.path('.npmrc'), 'registry=https://corp.example/one/');
    const first = loadReleaseRegistryConfiguration(
      f.path('packages/a/src'),
      f.environment,
    );
    await writeFile(f.path('.npmrc'), 'registry=https://corp.example/two/');
    const second = loadReleaseRegistryConfiguration(f.rootDir, f.environment);
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requests.push(url);
        return Response.json({ versions: {} });
      }),
    );
    const state = createReleaseConsistencyState(first);
    await fetchRegistryPackageMetadata(
      '@team/pkg',
      state,
      first.authorityFor('@team/pkg'),
    );
    await fetchRegistryPackageMetadata(
      '@team/pkg',
      state,
      second.authorityFor('@team/pkg'),
    );
    await fetchRegistryPackageMetadata(
      '@team/pkg',
      state,
      first.authorityFor('@team/pkg'),
    );
    expect(requests).toEqual([
      'https://corp.example/one/%40team%2Fpkg',
      'https://corp.example/two/%40team%2Fpkg',
    ]);
  });

  it('uses project, user, global, then npm default when higher layers are absent', async () => {
    const f = await fixture();
    const layers = [
      [f.path('.npmrc'), 'project'],
      [f.path('user.npmrc'), 'user'],
      [f.path('global.npmrc'), 'global'],
    ] as const;
    for (const [file, host] of layers)
      await writeFile(file, `registry=https://${host}.example/`);
    for (const [file, host] of layers) {
      expect(
        loadReleaseRegistryConfiguration(f.rootDir, f.environment).authorityFor(
          'pkg',
        ).baseUrl,
      ).toBe(`https://${host}.example/`);
      await writeFile(file, '');
    }
    expect(
      loadReleaseRegistryConfiguration(f.rootDir, f.environment).authorityFor(
        'pkg',
      ).baseUrl,
    ).toBe('https://registry.npmjs.org/');
  });

  it.each([
    'http://127.0.0.1/',
    'https://user:secret@corp.example/',
    'https://corp.example/?',
    'https://corp.example/#',
    'not-a-url',
  ])('fails closed for selected authority %s', async (value) => {
    const f = await fixture();
    const snapshot = loadReleaseRegistryConfiguration(f.rootDir, {
      ...f.environment,
      NPM_CONFIG_REGISTRY: value,
    });
    expect(() => snapshot.authorityFor('pkg')).toThrow(
      /Invalid release registry authority/u,
    );
  });

  it('rejects unreadable, missing explicit, non-string and uninterpolated registry configuration', async () => {
    const f = await fixture();
    expect(() =>
      loadReleaseRegistryConfiguration(f.rootDir, {
        ...f.environment,
        NPM_CONFIG_USERCONFIG: f.path('missing'),
      }),
    ).toThrow(/does not exist/u);
    expect(() =>
      loadReleaseRegistryConfiguration(f.rootDir, {
        ...f.environment,
        NPM_CONFIG_USERCONFIG: f.rootDir,
      }),
    ).toThrow(/unable to read/u);
    for (const contents of [
      'registry[]=https://corp.example/',
      'registry=https://${UNSET_REGISTRY_HOST}/',
    ]) {
      await writeFile(f.path('.npmrc'), contents);
      expect(() =>
        loadReleaseRegistryConfiguration(f.rootDir, f.environment),
      ).toThrow(/Invalid release registry authority/u);
    }
  });

  it('rejects URL boundary violations before fetch and keeps secrets out of errors', async () => {
    const f = await fixture();
    const authority = loadReleaseRegistryConfiguration(f.rootDir, {
      ...f.environment,
      NPM_CONFIG_REGISTRY: 'https://CORP.example:443/npm/',
    }).authorityFor('@team/a');
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    for (const value of [
      'https://corp.example.evil/a',
      'https://corp.example:444/a',
      'http://corp.example/a',
      '//corp.example/a',
      '/a',
      'https://user:secret@corp.example/a',
      'https://corp.example/a?secret=1',
      'https://corp.example/a#secret',
    ]) {
      await expect(
        fetchRegistryTarball(value, authority),
      ).rejects.toMatchObject({ failure: { kind: 'tarball-url-not-allowed' } });
      await expect(fetchRegistryTarball(value, authority)).rejects.not.toThrow(
        /secret/u,
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      (
        await fetchRegistryTarball('https://corp.example/a', authority)
      ).toString(),
    ).toBe('ok');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://corp.example/a',
      expect.objectContaining({ redirect: 'error' }),
    );
  });
});

describe('bounded registry response bodies', () => {
  it.each(['metadata', 'tarball'] as const)(
    'enforces the %s cap before reading Content-Length and while streaming',
    async (kind) => {
      const f = await fixture();
      const configuration = loadReleaseRegistryConfiguration(
        f.rootDir,
        f.environment,
      );
      const authority = configuration.authorityFor('pkg');
      const limit = (kind === 'metadata' ? 16 : 128) * 1024 * 1024;
      const cancel = vi.fn();
      const invoke = () =>
        kind === 'metadata'
          ? fetchRegistryPackageMetadata(
              'pkg',
              createReleaseConsistencyState(configuration),
              authority,
            )
          : fetchRegistryTarball(
              'https://registry.npmjs.org/pkg.tgz',
              authority,
            );
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 }),
              { headers: { 'content-length': String(limit + 1) } },
            ),
        ),
      );
      if (kind === 'metadata')
        expect(await invoke()).toMatchObject({
          kind: 'failure',
          reason: 'body-too-large',
          maxBytes: limit,
        });
      else
        await expect(invoke()).rejects.toMatchObject({
          failure: { kind: 'tarball-body-too-large', maxBytes: limit },
        });
      expect(cancel).toHaveBeenCalledOnce();
      cancel.mockClear();
      const chunk = new Uint8Array(1024 * 1024);
      let emitted = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              new ReadableStream<Uint8Array>(
                {
                  pull(controller) {
                    emitted += chunk.length;
                    controller.enqueue(chunk);
                  },
                  cancel,
                },
                { highWaterMark: 0 },
              ),
              { headers: { 'content-length': '1' } },
            ),
        ),
      );
      if (kind === 'metadata')
        expect(await invoke()).toMatchObject({
          reason: 'body-too-large',
          receivedBytes: limit + chunk.length,
        });
      else
        await expect(invoke()).rejects.toMatchObject({
          failure: {
            kind: 'tarball-body-too-large',
            receivedBytes: limit + chunk.length,
          },
        });
      expect(emitted).toBe(limit + chunk.length);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it.each(['metadata', 'tarball'] as const)(
    'accepts %s exactly at its limit',
    async (kind) => {
      const f = await fixture();
      const configuration = loadReleaseRegistryConfiguration(
        f.rootDir,
        f.environment,
      );
      const authority = configuration.authorityFor('pkg');
      const limit = (kind === 'metadata' ? 16 : 128) * 1024 * 1024;
      const body =
        kind === 'metadata'
          ? `{"x":"${'a'.repeat(limit - 8)}"}`
          : new Uint8Array(limit);
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(body, {
              headers: { 'content-length': String(limit) },
            }),
        ),
      );
      if (kind === 'metadata')
        expect(
          await fetchRegistryPackageMetadata(
            'pkg',
            createReleaseConsistencyState(configuration),
            authority,
          ),
        ).toMatchObject({ kind: 'found' });
      else
        expect(
          (
            await fetchRegistryTarball(
              'https://registry.npmjs.org/pkg.tgz',
              authority,
            )
          ).length,
        ).toBe(limit);
    },
  );
});
