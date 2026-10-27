import type { NativeEvidenceSnapshot } from './native-evidence';

// Only objects validated and recursively copied here qualify for sharing.
// Object.freeze on a caller-owned compiler object is not a DTO proof.
const published = new WeakSet<object>();

export function isPublishedNativeData(value: unknown): value is object {
  return value !== null && typeof value === 'object' && published.has(value);
}

function clonePrimitive(value: unknown): unknown {
  if (typeof value === 'number') return cloneNumber(value);
  if (['string', 'number', 'boolean'].includes(typeof value)) return value;
  throw new TypeError('Evidence must contain only JSON data');
}

function cloneNumber(value: number): number {
  if (!Number.isFinite(value)) throw new TypeError('Non-finite evidence');
  return value;
}
function cloneEntries(value: object, ancestors: ReadonlySet<object>): object {
  assertDataProperties(value);
  if (Array.isArray(value))
    return value.map((item: unknown) => cloneData(item, ancestors));
  if (Object.getPrototypeOf(value) !== Object.prototype)
    throw new TypeError('Non-DTO evidence');
  return clonePlainEntries(value, ancestors);
}

function clonePlainEntries(
  value: object,
  ancestors: ReadonlySet<object>,
): object {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]: [string, unknown]) => [
      key,
      cloneData(item, ancestors),
    ]),
  );
}

function assertDataProperties(value: object): void {
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  if (descriptors.some((descriptor) => !('value' in descriptor))) {
    throw new TypeError('Evidence accessors are not data');
  }
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw new TypeError('Symbol evidence');
}
function cloneData(value: unknown, ancestors: ReadonlySet<object>): unknown {
  if (value === null) return null;
  return typeof value === 'object'
    ? cloneObject(value, ancestors)
    : clonePrimitive(value);
}

function cloneObject(value: object, ancestors: ReadonlySet<object>): object {
  if (published.has(value)) return value;
  if (ancestors.has(value)) throw new TypeError('Cyclic evidence');
  const next = new Set(ancestors).add(value);
  const result = Object.freeze(cloneEntries(value, next));
  published.add(result);
  return result;
}

/**
 * Copy before freezing: no internal mutable arrays/maps or compiler handles
 * escape. This is not a cache decoder or a grant of evidence eligibility.
 */
export function freezeNativeEvidence(
  snapshot: NativeEvidenceSnapshot,
): NativeEvidenceSnapshot {
  return freezeNativeData(snapshot);
}

/**
Internal DTO publication helper, not an execution or persistence capability.
*/
export function freezeNativeData<T>(value: T): T {
  return cloneData(value, new Set()) as T;
}
