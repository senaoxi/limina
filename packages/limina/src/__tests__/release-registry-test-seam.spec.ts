import { describe, expect, it } from 'vitest';
import {
  INTERNAL_RELEASE_REGISTRY_TIMEOUT_ENV,
  INTERNAL_RELEASE_REGISTRY_URL_ENV,
  readReleaseRegistryTestAuthority,
} from '../package-check/release-registry-test-seam';
import { resolveReleaseRegistryMetadataUrl } from '../package-check/release/registry/authority';
import { resolveRegistryTarballUrl } from '../package-check/release/registry/tarball-url';

describe('release registry test authority', () => {
  it('only grants authority with the explicit loopback HTTP environment variable', () => {
    expect(
      readReleaseRegistryTestAuthority({
        [INTERNAL_RELEASE_REGISTRY_TIMEOUT_ENV]: '1',
      }),
    ).toBeUndefined();
    const authority = readReleaseRegistryTestAuthority({
      [INTERNAL_RELEASE_REGISTRY_URL_ENV]: 'http://127.0.0.1:43127/npm/',
      [INTERNAL_RELEASE_REGISTRY_TIMEOUT_ENV]: '125',
    })!;
    expect(authority).toMatchObject({ kind: 'test', timeoutMs: 125 });
    expect(resolveReleaseRegistryMetadataUrl('@scope/pkg', authority)).toBe(
      'http://127.0.0.1:43127/npm/%40scope%2Fpkg',
    );
    expect(
      resolveRegistryTarballUrl('http://127.0.0.1:43127/pkg.tgz', authority),
    ).toBe('http://127.0.0.1:43127/pkg.tgz');
    for (const url of [
      'https://registry.npmjs.org/pkg.tgz',
      'http://127.0.0.1:43128/pkg.tgz',
      'http://127.0.0.1:43127/pkg.tgz?secret=1',
      'http://user@127.0.0.1:43127/pkg.tgz',
    ]) {
      expect(() => resolveRegistryTarballUrl(url, authority)).toThrow(
        /not allowed/u,
      );
    }
  });
  it.each([
    'https://registry.npmjs.org/',
    'http://example.com/',
    'http://localhost/?',
    'http://localhost/#',
    'http://user:secret@localhost/',
  ])('rejects invalid test authority %s', (url) => {
    expect(() =>
      readReleaseRegistryTestAuthority({
        [INTERNAL_RELEASE_REGISTRY_URL_ENV]: url,
      }),
    ).toThrow(/Invalid release registry authority/u);
  });
  it('retains the bounded test timeout', () => {
    expect(() =>
      readReleaseRegistryTestAuthority({
        [INTERNAL_RELEASE_REGISTRY_URL_ENV]: 'http://localhost/',
        [INTERNAL_RELEASE_REGISTRY_TIMEOUT_ENV]: '1',
      }),
    ).toThrow(/10 through 10000/u);
  });
});
