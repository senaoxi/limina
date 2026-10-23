import { types } from 'node:util';
import { z } from 'zod';
import { addConfigIssue, type ConfigValidationContext } from './shared';

const domains = ['graph', 'source', 'proof'] as const;

interface DataValidation {
  context: ConfigValidationContext;
  path: PropertyKey[];
  seen: Set<object>;
  value: unknown;
}

type ContainerValidation = DataValidation & { value: object };
type PropertyValidation = ContainerValidation & { key: PropertyKey };

function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

function hasDataPrototype(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return Array.isArray(value)
    ? prototype === Array.prototype
    : prototype === Object.prototype || prototype === null;
}

function isInheritedDomain(prototype: object, domain: string): boolean {
  return types.isProxy(prototype) || Object.hasOwn(prototype, domain);
}

function hasInheritedDomain(value: object, domain: string): boolean {
  let prototype = Object.getPrototypeOf(value);
  while (prototype !== null) {
    if (isInheritedDomain(prototype, domain)) return true;
    prototype = Object.getPrototypeOf(prototype);
  }
  return false;
}

function isKnipTag(path: PropertyKey[], key: PropertyKey): boolean {
  return path.join('.') === 'source.knip' && key === Symbol.toStringTag;
}

function isKnipMetadata(
  options: PropertyValidation,
  property: PropertyDescriptor,
): boolean {
  return (
    isKnipTag(options.path, options.key) && typeof property.value === 'string'
  );
}

function isVisibleDataKey(
  key: PropertyKey,
  property: PropertyDescriptor,
): boolean {
  return typeof key === 'string' && property.enumerable === true;
}

function validateDataProperty(
  options: PropertyValidation,
  property: PropertyDescriptor,
): void {
  if (isKnipMetadata(options, property)) return;
  const path = [...options.path, options.key];
  if (!isVisibleDataKey(options.key, property)) {
    addConfigIssue(
      options.context,
      path,
      'governance fields must be enumerable string properties.',
    );
    return;
  }
  validateData({ ...options, path, value: property.value });
}

function validateProperty(options: PropertyValidation): void {
  const property = Object.getOwnPropertyDescriptor(options.value, options.key)!;
  if (!('value' in property)) {
    addConfigIssue(
      options.context,
      [...options.path, options.key],
      'governance fields must be data properties; compute values in the config function.',
    );
    return;
  }
  validateDataProperty(options, property);
}

function isArrayIndex(key: PropertyKey): boolean {
  return (
    typeof key === 'string' &&
    /^(?:0|[1-9]\d*)$/u.test(key) &&
    Number(key) < 2 ** 32 - 1
  );
}

function validateArrayProperty(options: PropertyValidation): void {
  if (options.key === 'length') return;
  if (!isArrayIndex(options.key)) {
    addConfigIssue(
      options.context,
      [...options.path, options.key],
      'unknown governance array field.',
    );
    return;
  }
  validateProperty(options);
}

function validateContainerEntry(options: PropertyValidation): void {
  if (Array.isArray(options.value)) validateArrayProperty(options);
  else validateProperty(options);
}

function isInvalidContainer(options: ContainerValidation): boolean {
  return (
    types.isProxy(options.value) ||
    !hasDataPrototype(options.value) ||
    options.seen.has(options.value)
  );
}

function validateContainer(options: ContainerValidation): void {
  if (isInvalidContainer(options)) {
    addConfigIssue(
      options.context,
      options.path,
      'governance config must contain plain, non-cyclic data without proxies or inherited fields.',
    );
    return;
  }
  options.seen.add(options.value);
  for (const key of Reflect.ownKeys(options.value))
    validateContainerEntry({ ...options, key });
  options.seen.delete(options.value);
}

function validateData(options: DataValidation): void {
  if (options.value === undefined) {
    addConfigIssue(
      options.context,
      options.path,
      'explicit undefined is not supported; omit the field instead.',
    );
  } else if (isObject(options.value)) {
    validateContainer({ ...options, value: options.value });
  }
}

function validateAbsentDomain(
  value: object,
  domain: string,
  context: ConfigValidationContext,
): void {
  if (hasInheritedDomain(value, domain))
    addConfigIssue(
      context,
      [domain],
      'governance domains must be own data properties.',
    );
}

function validateDomain(
  value: object,
  domain: string,
  context: ConfigValidationContext,
): void {
  const property = Object.getOwnPropertyDescriptor(value, domain);
  if (property === undefined) {
    validateAbsentDomain(value, domain, context);
    return;
  }
  if (!('value' in property)) {
    addConfigIssue(
      context,
      [domain],
      'governance domains must be data properties; compute values in the config function.',
    );
    return;
  }
  validateData({
    value: property.value,
    path: [domain],
    context,
    seen: new Set(),
  });
}

function validateDomains(
  value: object,
  context: ConfigValidationContext,
): void {
  for (const domain of domains) validateDomain(value, domain, context);
}

/**
 * Guard original descriptors before Zod or diagnostics can read accessors.
 */
export const governanceDataSchema: z.ZodType = z
  .unknown()
  .superRefine((value, context) => {
    if (!isObject(value)) return;
    if (types.isProxy(value)) {
      addConfigIssue(context, [], 'config must be a data object, not a proxy.');
      return;
    }
    validateDomains(value, context);
  });
