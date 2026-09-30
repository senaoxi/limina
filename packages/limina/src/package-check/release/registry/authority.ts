export interface EffectiveRegistryAuthority {
  readonly kind: 'production' | 'test';
  readonly baseUrl: string;
  readonly origin: string;
  readonly source: string;
  readonly timeoutMs?: number;
}

export interface ReleaseRegistryConfig {
  authorityFor(packageName: string): EffectiveRegistryAuthority;
}

export class RegistryAuthorityError extends Error {
  override readonly name = 'RegistryAuthorityError';
  readonly source: string;

  constructor(source: string, problem: string) {
    // Values may contain credentials. Do not retain input-bearing URL errors.
    super(`Invalid release registry authority (${source}): ${problem}`);
    this.source = source;
  }
}

export function parseRegistryUrl(value: string, source: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new RegistryAuthorityError(source, 'expected an absolute URL');
  }
}

export function hasRegistryUrlSecrets(url: URL): boolean {
  return [
    url.username !== '',
    url.password !== '',
    url.href.includes('?'),
    url.href.includes('#'),
  ].some(Boolean);
}

function registryProtocol(kind: EffectiveRegistryAuthority['kind']): string {
  return kind === 'test' ? 'http:' : 'https:';
}

function validateAuthorityUrl(
  url: URL,
  kind: EffectiveRegistryAuthority['kind'],
  source: string,
): void {
  const protocol = registryProtocol(kind);
  if (url.protocol !== protocol || hasRegistryUrlSecrets(url)) {
    throw new RegistryAuthorityError(
      source,
      `expected ${protocol} without credentials, query, or fragment`,
    );
  }
}

export function createRegistryAuthority(options: {
  value: string;
  source: string;
  kind: EffectiveRegistryAuthority['kind'];
  timeoutMs?: number;
}): EffectiveRegistryAuthority {
  const url = parseRegistryUrl(options.value, options.source);
  validateAuthorityUrl(url, options.kind, options.source);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return Object.freeze({
    kind: options.kind,
    baseUrl: url.href,
    origin: url.origin,
    source: options.source,
    timeoutMs: options.timeoutMs,
  });
}

export function resolveReleaseRegistryMetadataUrl(
  packageName: string,
  authority: EffectiveRegistryAuthority,
): string {
  return new URL(encodeURIComponent(packageName), authority.baseUrl).href;
}

export function isRegistryTarballUrlAllowed(
  candidate: URL,
  authority: EffectiveRegistryAuthority,
): boolean {
  return [
    candidate.origin === authority.origin,
    candidate.protocol === (authority.kind === 'test' ? 'http:' : 'https:'),
    !hasRegistryUrlSecrets(candidate),
  ].every(Boolean);
}

export function redactRegistryUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return '[invalid URL]';
  }
}
