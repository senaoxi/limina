import { createHash } from 'node:crypto';

/**
 * A syntactically valid SRI integrity string used by fixtures that must supply
 * a well-formed `integrity` value while still exercising a downstream failure.
 */
export const VALID_PLACEHOLDER_INTEGRITY = `sha512-${createHash('sha512')
  .update('release detector fixture placeholder')
  .digest('base64')}`;

function hashOptionalContent(content: string | undefined): string | undefined {
  if (content === undefined) return undefined;
  return createHash('sha256').update(content).digest('hex');
}

function formatOptionalHash(
  label: 'local' | 'remote',
  hash: string | undefined,
): string | undefined {
  if (hash === undefined) return undefined;
  return `${label}=${hash}`;
}

/** Formats one expected content-hash diff evidence line. */
export function createReleaseContentDiffEvidenceLine(options: {
  readonly kind: 'changed' | 'local-only' | 'remote-only';
  readonly localContent?: string;
  readonly path: string;
  readonly remoteContent?: string;
}): string {
  const lines = [
    `${options.kind}: ${options.path}`,
    formatOptionalHash('local', hashOptionalContent(options.localContent)),
    formatOptionalHash('remote', hashOptionalContent(options.remoteContent)),
  ];
  return lines
    .filter((value): value is string => value !== undefined)
    .join(' ');
}
