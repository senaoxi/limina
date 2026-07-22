import { describe, expect, it } from 'vitest';

import {
  assertReleaseRegistryTarballUrlAllowed,
  INTERNAL_RELEASE_REGISTRY_TIMEOUT_ENV,
  INTERNAL_RELEASE_REGISTRY_URL_ENV,
  resolveReleaseRegistryMetadataUrl,
  resolveReleaseRegistryTimeoutMs,
} from '../package-check/release-registry-test-seam';

describe('Release registry integration test seam', () => {
  it('preserves the public npm registry default when the seam is absent', () => {
    expect(resolveReleaseRegistryMetadataUrl('@scope/pkg', {})).toBe(
      'https://registry.npmjs.org/%40scope%2Fpkg',
    );
    expect(resolveReleaseRegistryTimeoutMs(30_000, {})).toBe(30_000);
  });

  it('accepts only loopback registry URLs and bounded test timeouts', () => {
    const environment = {
      [INTERNAL_RELEASE_REGISTRY_TIMEOUT_ENV]: '125',
      [INTERNAL_RELEASE_REGISTRY_URL_ENV]: 'http://127.0.0.1:43127/',
    };

    expect(resolveReleaseRegistryMetadataUrl('@scope/pkg', environment)).toBe(
      'http://127.0.0.1:43127/%40scope%2Fpkg',
    );
    expect(resolveReleaseRegistryTimeoutMs(30_000, environment)).toBe(125);
    expect(() =>
      resolveReleaseRegistryMetadataUrl('@scope/pkg', {
        [INTERNAL_RELEASE_REGISTRY_URL_ENV]: 'https://registry.npmjs.org/',
      }),
    ).toThrow(/loopback host/u);
    expect(() =>
      resolveReleaseRegistryTimeoutMs(30_000, {
        ...environment,
        [INTERNAL_RELEASE_REGISTRY_TIMEOUT_ENV]: '1',
      }),
    ).toThrow(/10 through 10000/u);
  });

  it('blocks non-loopback and cross-origin tarballs while the seam is active', () => {
    const environment = {
      [INTERNAL_RELEASE_REGISTRY_URL_ENV]: 'http://127.0.0.1:43127/',
    };

    expect(() =>
      assertReleaseRegistryTarballUrlAllowed(
        'http://127.0.0.1:43127/tarballs/pkg.tgz',
        environment,
      ),
    ).not.toThrow();
    expect(() =>
      assertReleaseRegistryTarballUrlAllowed(
        'https://registry.npmjs.org/pkg.tgz',
        environment,
      ),
    ).toThrow(/may only download tarballs/u);
    expect(() =>
      assertReleaseRegistryTarballUrlAllowed(
        'http://127.0.0.1:43128/pkg.tgz',
        environment,
      ),
    ).toThrow(/may only download tarballs/u);
  });
});
