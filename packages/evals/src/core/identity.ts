import { sha256 } from './snapshot.ts';

/**
JSON identities reject unsupported values instead of dropping them silently.
*/
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error('Identity requires plain JSON data');
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).toSorted((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  );
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

export function contentIdentity(value: unknown): string {
  return sha256(canonicalJson(value));
}
