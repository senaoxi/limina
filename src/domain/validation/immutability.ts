function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function isInspectableObject(value: unknown): value is object {
  return Boolean(value) && typeof value === 'object';
}

function isMapOrSet(value: object): boolean {
  return value instanceof Map || value instanceof Set;
}

function isSupportedValidationContainer(value: object): boolean {
  return Array.isArray(value) || isPlainRecord(value);
}

function assertSupportedValidationObject(value: object): void {
  if (isMapOrSet(value)) {
    throw new TypeError(
      'Validation views must not contain Map or Set instances.',
    );
  }

  if (!isSupportedValidationContainer(value)) {
    throw new Error('Validation views must contain only plain DTO objects.');
  }
}

function assertFrozenValidationObject(value: object): void {
  if (!Object.isFrozen(value)) {
    throw new Error('Validation view objects and arrays must be frozen.');
  }
}

function assertNotFunction(value: unknown): void {
  if (typeof value === 'function') {
    throw new TypeError('Validation views must not contain functions.');
  }
}

function assertValidationChildrenImmutable(
  value: object,
  seen: Set<object>,
): void {
  for (const child of Object.values(value)) {
    assertImmutableValidationValueInternal(child, seen);
  }
}

function assertImmutableValidationValueInternal(
  value: unknown,
  seen: Set<object>,
): void {
  assertNotFunction(value);

  if (!isInspectableObject(value)) {
    return;
  }

  if (seen.has(value)) {
    return;
  }

  assertSupportedValidationObject(value);
  assertFrozenValidationObject(value);
  seen.add(value);
  assertValidationChildrenImmutable(value, seen);
}

export function assertImmutableValidationValue(value: unknown): void {
  assertImmutableValidationValueInternal(value, new Set());
}

export function freezeRecord<Value>(
  entries: Iterable<readonly [string, Value]>,
): Readonly<Record<string, Value>> {
  return Object.freeze(Object.fromEntries(entries));
}

export function freezeArray<Value>(values: Iterable<Value>): readonly Value[] {
  return Object.freeze([...values]);
}
