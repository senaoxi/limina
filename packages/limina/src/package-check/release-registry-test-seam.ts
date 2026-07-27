const DEFAULT_NPM_REGISTRY_URL = 'https://registry.npmjs.org/';
const loopbackHostnames = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

export const INTERNAL_RELEASE_REGISTRY_URL_ENV =
  'LIMINA_INTERNAL_TEST_REGISTRY_URL';
export const INTERNAL_RELEASE_REGISTRY_TIMEOUT_ENV =
  'LIMINA_INTERNAL_TEST_REGISTRY_TIMEOUT_MS';

function isLoopbackHostname(hostname: string): boolean {
  return loopbackHostnames.has(hostname);
}

function parseAbsoluteUrl(value: string, errorMessage: string): URL {
  try {
    return new URL(value);
  } catch (error) {
    throw new Error(errorMessage, { cause: error });
  }
}

function isValidInternalRegistryUrl(url: URL): boolean {
  return [
    url.protocol === 'http:',
    isLoopbackHostname(url.hostname),
    url.username === '',
    url.password === '',
    url.search === '',
    url.hash === '',
  ].every(Boolean);
}

function assertValidInternalRegistryUrl(url: URL): void {
  if (!isValidInternalRegistryUrl(url)) {
    throw new Error(
      `${INTERNAL_RELEASE_REGISTRY_URL_ENV} must use plain HTTP on a loopback host without credentials, query, or fragment.`,
    );
  }
}

function readInternalRegistryBaseUrl(
  environment: NodeJS.ProcessEnv,
): URL | undefined {
  const configured = environment[INTERNAL_RELEASE_REGISTRY_URL_ENV];

  if (configured === undefined) {
    return undefined;
  }

  const url = parseAbsoluteUrl(
    configured,
    `${INTERNAL_RELEASE_REGISTRY_URL_ENV} must be an absolute loopback URL.`,
  );
  assertValidInternalRegistryUrl(url);
  return url;
}

function getReleaseRegistryBaseUrl(environment: NodeJS.ProcessEnv): URL {
  const internalUrl = readInternalRegistryBaseUrl(environment);
  return internalUrl === undefined
    ? new URL(DEFAULT_NPM_REGISTRY_URL)
    : internalUrl;
}

function ensureTrailingSlash(url: URL): URL {
  const normalized = new URL(url);

  if (!normalized.pathname.endsWith('/')) {
    normalized.pathname = `${normalized.pathname}/`;
  }

  return normalized;
}

export function resolveReleaseRegistryMetadataUrl(
  packageName: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const baseUrl = ensureTrailingSlash(getReleaseRegistryBaseUrl(environment));
  return new URL(encodeURIComponent(packageName), baseUrl).toString();
}

function isValidTimeout(timeoutMs: number): boolean {
  return [
    Number.isSafeInteger(timeoutMs),
    timeoutMs >= 10,
    timeoutMs <= 10_000,
  ].every(Boolean);
}

function parseRegistryTimeout(configured: string): number {
  const timeoutMs = Number(configured);

  if (!isValidTimeout(timeoutMs)) {
    throw new Error(
      `${INTERNAL_RELEASE_REGISTRY_TIMEOUT_ENV} must be an integer from 10 through 10000.`,
    );
  }

  return timeoutMs;
}

function resolveConfiguredTimeout(
  configured: string | undefined,
  defaultTimeoutMs: number,
): number {
  return configured === undefined
    ? defaultTimeoutMs
    : parseRegistryTimeout(configured);
}

export function resolveReleaseRegistryTimeoutMs(
  defaultTimeoutMs: number,
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const internalRegistryUrl = readInternalRegistryBaseUrl(environment);

  if (internalRegistryUrl === undefined) {
    return defaultTimeoutMs;
  }

  return resolveConfiguredTimeout(
    environment[INTERNAL_RELEASE_REGISTRY_TIMEOUT_ENV],
    defaultTimeoutMs,
  );
}

function isAllowedInternalTarball(candidate: URL, baseUrl: URL): boolean {
  return [
    candidate.protocol === 'http:',
    isLoopbackHostname(candidate.hostname),
    candidate.origin === baseUrl.origin,
  ].every(Boolean);
}

function assertAllowedInternalTarball(candidate: URL, baseUrl: URL): void {
  if (!isAllowedInternalTarball(candidate, baseUrl)) {
    throw new Error(
      `Internal Release registry fixtures may only download tarballs from ${baseUrl.origin}.`,
    );
  }
}

export function assertReleaseRegistryTarballUrlAllowed(
  tarballUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const baseUrl = readInternalRegistryBaseUrl(environment);

  if (baseUrl === undefined) {
    return;
  }

  const candidate = parseAbsoluteUrl(
    tarballUrl,
    'Registry tarball URL must be absolute.',
  );
  assertAllowedInternalTarball(candidate, baseUrl);
}
