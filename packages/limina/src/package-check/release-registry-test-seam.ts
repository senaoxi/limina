import {
  createRegistryAuthority,
  type EffectiveRegistryAuthority,
  parseRegistryUrl,
  RegistryAuthorityError,
} from './release/registry/authority';

const loopbackHostnames = new Set(['127.0.0.1', '[::1]', 'localhost']);
export const INTERNAL_RELEASE_REGISTRY_URL_ENV =
  'LIMINA_INTERNAL_TEST_REGISTRY_URL';
export const INTERNAL_RELEASE_REGISTRY_TIMEOUT_ENV =
  'LIMINA_INTERNAL_TEST_REGISTRY_TIMEOUT_MS';

function readTestTimeout(environment: NodeJS.ProcessEnv): number | undefined {
  const configured = environment[INTERNAL_RELEASE_REGISTRY_TIMEOUT_ENV];
  if (configured === undefined) return undefined;
  const timeoutMs = Number(configured);
  if (
    ![
      Number.isSafeInteger(timeoutMs),
      timeoutMs >= 10,
      timeoutMs <= 10_000,
    ].every(Boolean)
  ) {
    throw new RegistryAuthorityError(
      INTERNAL_RELEASE_REGISTRY_TIMEOUT_ENV,
      'expected an integer from 10 through 10000',
    );
  }
  return timeoutMs;
}

export function readReleaseRegistryTestAuthority(
  environment: NodeJS.ProcessEnv,
): EffectiveRegistryAuthority | undefined {
  const value = environment[INTERNAL_RELEASE_REGISTRY_URL_ENV];
  if (value === undefined) return undefined;
  const url = parseRegistryUrl(value, INTERNAL_RELEASE_REGISTRY_URL_ENV);
  if (!loopbackHostnames.has(url.hostname))
    throw new RegistryAuthorityError(
      INTERNAL_RELEASE_REGISTRY_URL_ENV,
      'expected a loopback host',
    );
  return createRegistryAuthority({
    kind: 'test',
    value,
    source: INTERNAL_RELEASE_REGISTRY_URL_ENV,
    timeoutMs: readTestTimeout(environment),
  });
}
