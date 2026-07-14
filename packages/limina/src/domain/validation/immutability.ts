function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

export function assertImmutableValidationValue(
  value: unknown,
  seen: Set<object> = new Set(),
): void {
  if (typeof value === 'function') {
    throw new TypeError('Validation views must not contain functions.');
  }

  if (!value || typeof value !== 'object' || seen.has(value)) {
    return;
  }

  if (value instanceof Map || value instanceof Set) {
    throw new TypeError(
      'Validation views must not contain Map or Set instances.',
    );
  }

  if (!Array.isArray(value) && !isPlainRecord(value)) {
    throw new Error('Validation views must contain only plain DTO objects.');
  }

  if (!Object.isFrozen(value)) {
    throw new Error('Validation view objects and arrays must be frozen.');
  }

  seen.add(value);

  for (const child of Object.values(value)) {
    assertImmutableValidationValue(child, seen);
  }
}

export function freezeRecord<Value>(
  entries: Iterable<readonly [string, Value]>,
): Readonly<Record<string, Value>> {
  return Object.freeze(Object.fromEntries(entries));
}

export function freezeArray<Value>(values: Iterable<Value>): readonly Value[] {
  return Object.freeze([...values]);
}
