import { RegistryTarballError } from '../consistency/types';
import {
  type EffectiveRegistryAuthority,
  isRegistryTarballUrlAllowed,
  redactRegistryUrl,
} from './authority';

function parseTarballUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

export function resolveRegistryTarballUrl(
  value: string,
  authority: EffectiveRegistryAuthority,
): string {
  const url = parseTarballUrl(value);
  if (url !== undefined && isRegistryTarballUrlAllowed(url, authority))
    return url.href;
  throw new RegistryTarballError(
    { kind: 'tarball-url-not-allowed', tarballUrl: redactRegistryUrl(value) },
    `Registry tarball URL is not allowed by release registry authority ${authority.origin}; expected the same origin without credentials, query, or fragment`,
  );
}
