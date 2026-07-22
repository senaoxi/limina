import { createHash } from 'node:crypto';

/**
 * A syntactically valid SRI integrity string used by fixtures that must supply
 * a well-formed `integrity` value while still exercising a downstream failure
 * (a tarball body/request fault) rather than an integrity comparison. The exact
 * digest is arbitrary; only its shape matters to the release checker.
 */
export const VALID_PLACEHOLDER_INTEGRITY = `sha512-${createHash('sha512')
  .update('release detector fixture placeholder')
  .digest('base64')}`;

/**
 * Formats a single expected content-hash diff evidence line exactly as the
 * release content-hash detector emits it: `"<kind>: <path>"` followed by the
 * SHA-256 of the local and/or remote file content. Fixtures call this so the
 * expected hashes are derived from the same bytes the repo ships, instead of
 * pasted opaque literals.
 */
export function createReleaseContentDiffEvidenceLine(options: {
  readonly kind: 'changed' | 'local-only' | 'remote-only';
  readonly localContent?: string;
  readonly path: string;
  readonly remoteContent?: string;
}): string {
  const localHash =
    options.localContent === undefined
      ? undefined
      : createHash('sha256').update(options.localContent).digest('hex');
  const remoteHash =
    options.remoteContent === undefined
      ? undefined
      : createHash('sha256').update(options.remoteContent).digest('hex');

  return [
    `${options.kind}: ${options.path}`,
    localHash ? `local=${localHash}` : undefined,
    remoteHash ? `remote=${remoteHash}` : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(' ');
}
