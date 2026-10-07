import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { encodeData } from '../core/analysis-cache/data-codec';

function hasDataPrototype(value: object): boolean {
  const allowed = Array.isArray(value)
    ? [Array.prototype]
    : [Object.prototype, null];
  return allowed.includes(Object.getPrototypeOf(value));
}
function isDataContainer(value: object): boolean {
  if (types.isProxy(value)) return false;
  const properties = Object.getOwnPropertyDescriptors(value);
  return [
    hasDataPrototype(value),
    Object.getOwnPropertySymbols(value).length === 0,
    Object.values(properties).every((property) => 'value' in property),
  ].every(Boolean);
}
/*
Own pure data for this invocation; retain executable/opaque values explicitly.
*/
export function captureInvocationData<T>(value: T): T {
  return capture(value, new Map()) as T;
}
function capture(value: unknown, seen: Map<object, unknown>): unknown {
  return value === null || typeof value !== 'object'
    ? value
    : captureObject(value, seen);
}
function captureObject(value: object, seen: Map<object, unknown>): unknown {
  if (!isDataContainer(value)) return value;
  const prior = seen.get(value);
  return prior === undefined ? captureNewObject(value, seen) : prior;
}
function captureNewObject(value: object, seen: Map<object, unknown>): object {
  const result = Array.isArray(value) ? [] : {};
  seen.set(value, result);
  const properties = Object.entries(Object.getOwnPropertyDescriptors(value));
  for (const [key, property] of properties)
    captureProperty({ result, key, property, seen });
  return Object.freeze(result);
}
function captureProperty(options: {
  result: object;
  key: string;
  property: PropertyDescriptor;
  seen: Map<object, unknown>;
}): void {
  if (options.key === 'length' && Array.isArray(options.result)) {
    Object.defineProperty(options.result, 'length', {
      value: options.property.value,
    });
    return;
  }
  Object.defineProperty(options.result, options.key, {
    value: capture(options.property.value, options.seen),
    enumerable: options.property.enumerable,
  });
}
function requireContainer(value: object, seen: Set<object>): void {
  if (
    [!isDataContainer(value), !hasArrayDataShape(value), seen.has(value)].some(
      Boolean,
    )
  )
    throw new Error('Opaque or cyclic configuration.');
  seen.add(value);
  const properties = Object.values(Object.getOwnPropertyDescriptors(value));
  for (const property of properties) requirePureData(property.value, seen);
  seen.delete(value);
}
function requirePureData(value: unknown, seen: Set<object>): void {
  if (typeof value === 'function') throw new Error('Executable configuration.');
  if (isObjectData(value)) requireContainer(value, seen);
}
function isObjectData(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}
function isArrayProperty(key: string): boolean {
  return key === 'length' || isArrayIndex(key);
}
function isArrayIndex(key: string): boolean {
  return [/^(?:0|[1-9]\d*)$/.test(key), Number(key) < 4_294_967_295].every(
    Boolean,
  );
}
function hasArrayDataShape(value: object): boolean {
  return (
    !Array.isArray(value) ||
    Object.getOwnPropertyNames(value).every(isArrayProperty)
  );
}

function versionData(value: unknown): unknown {
  if (!isObjectData(value)) return encodeData(value);
  // Enumeration affects effective data consumption even after deep freezing.
  // Preserve that shape for every property, without classifying config fields.
  const entries = Object.entries(Object.getOwnPropertyDescriptors(value)).map(
    ([key, property]) => [
      key,
      property.enumerable,
      versionData(property.value),
    ],
  );
  return [Array.isArray(value) ? 'array' : 'object', entries];
}
/*
undefined disqualifies the persistent analysis model for this invocation.
*/
export function invocationDataVersion(value: unknown): string | undefined {
  try {
    requirePureData(value, new Set());
    const encoded = JSON.stringify(['invocation-data-v2', versionData(value)]);
    return createHash('sha256').update(encoded).digest('hex');
  } catch {
    return undefined;
  }
}
