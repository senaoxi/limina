const DEFAULT_NPM_REGISTRY_URL = 'https://registry.npmjs.org/';

export const INTERNAL_RELEASE_REGISTRY_URL_ENV =
  'LIMINA_INTERNAL_TEST_REGISTRY_URL';
export const INTERNAL_RELEASE_REGISTRY_TIMEOUT_ENV =
  'LIMINA_INTERNAL_TEST_REGISTRY_TIMEOUT_MS';

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname === 'localhost'
  );
}

function readInternalRegistryBaseUrl(
  environment: NodeJS.ProcessEnv,
): URL | undefined {
  const configured = environment[INTERNAL_RELEASE_REGISTRY_URL_ENV];
  if (configured === undefined) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(configured);
  } catch (error) {
    throw new Error(
      `${INTERNAL_RELEASE_REGISTRY_URL_ENV} must be an absolute loopback URL.`,
      { cause: error },
    );
  }

  if (
    url.protocol !== 'http:' ||
    !isLoopbackHostname(url.hostname) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(
      `${INTERNAL_RELEASE_REGISTRY_URL_ENV} must use plain HTTP on a loopback host without credentials, query, or fragment.`,
    );
  }

  return url;
}

export function resolveReleaseRegistryMetadataUrl(
  packageName: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const baseUrl =
    readInternalRegistryBaseUrl(environment) ??
    new URL(DEFAULT_NPM_REGISTRY_URL);
  const normalizedBaseUrl = new URL(baseUrl);
  normalizedBaseUrl.pathname = normalizedBaseUrl.pathname.endsWith('/')
    ? normalizedBaseUrl.pathname
    : `${normalizedBaseUrl.pathname}/`;

  return new URL(encodeURIComponent(packageName), normalizedBaseUrl).toString();
}

export function resolveReleaseRegistryTimeoutMs(
  defaultTimeoutMs: number,
  environment: NodeJS.ProcessEnv = process.env,
): number {
  if (readInternalRegistryBaseUrl(environment) === undefined) {
    return defaultTimeoutMs;
  }

  const configured = environment[INTERNAL_RELEASE_REGISTRY_TIMEOUT_ENV];
  if (configured === undefined) {
    return defaultTimeoutMs;
  }

  const timeoutMs = Number(configured);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 10 ||
    timeoutMs > 10_000
  ) {
    throw new Error(
      `${INTERNAL_RELEASE_REGISTRY_TIMEOUT_ENV} must be an integer from 10 through 10000.`,
    );
  }

  return timeoutMs;
}

export function assertReleaseRegistryTarballUrlAllowed(
  tarballUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const baseUrl = readInternalRegistryBaseUrl(environment);
  if (baseUrl === undefined) {
    return;
  }

  let candidate: URL;
  try {
    candidate = new URL(tarballUrl);
  } catch (error) {
    throw new Error('Registry tarball URL must be absolute.', { cause: error });
  }

  if (
    candidate.protocol !== 'http:' ||
    !isLoopbackHostname(candidate.hostname) ||
    candidate.origin !== baseUrl.origin
  ) {
    throw new Error(
      `Internal Release registry fixtures may only download tarballs from ${baseUrl.origin}.`,
    );
  }
}
