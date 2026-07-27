import path from 'pathe';

export interface ConfigValidationContext {
  addIssue(issue: {
    code: 'custom';
    message: string;
    path: PropertyKey[];
  }): void;
}

export interface StringArrayFieldOptions {
  ctx: ConfigValidationContext;
  path: PropertyKey[];
  required?: boolean;
  value: unknown;
  valueName: string;
}

export function addConfigIssue(
  ctx: ConfigValidationContext,
  pathSegments: PropertyKey[],
  message: string,
): void {
  ctx.addIssue({ code: 'custom', message, path: pathSegments });
}

export function isPlainConfigRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null) return false;
  if (typeof value !== 'object') return false;
  return !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return value.trim().length > 0;
}

export function isAbsolutePublicSelector(value: string): boolean {
  const selector = value.trim().replace(/^!+/u, '');
  if (path.isAbsolute(selector)) return true;
  return /^[A-Za-z]:[\\/]/u.test(selector);
}

function isReservedPathSegment(value: string): boolean {
  return value === '.' || value === '..';
}

export function isPathSafeIdentifier(value: string): boolean {
  return (
    value.length > 0 && !isReservedPathSegment(value) && !/[\\/]/u.test(value)
  );
}

function addMissingArrayIssue(options: StringArrayFieldOptions): void {
  addConfigIssue(
    options.ctx,
    options.path,
    `${options.valueName} must be a non-empty string array.`,
  );
}

function addInvalidArrayEntryIssue(
  options: StringArrayFieldOptions,
  index: number,
): void {
  addConfigIssue(
    options.ctx,
    [...options.path, index],
    `${options.valueName} entries must be non-empty strings.`,
  );
}

function validateArrayEntries(
  options: StringArrayFieldOptions,
  values: readonly unknown[],
): void {
  for (const [index, value] of values.entries()) {
    if (isNonEmptyString(value)) continue;
    addInvalidArrayEntryIssue(options, index);
  }
}

function handleMissingArray(options: StringArrayFieldOptions): boolean {
  if (options.required === true) addMissingArrayIssue(options);
  return false;
}

function isNonEmptyArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)) return false;
  return value.length > 0;
}

export function validateStringArrayField(
  options: StringArrayFieldOptions,
): boolean {
  if (options.value === undefined) return handleMissingArray(options);
  if (!isNonEmptyArray(options.value)) {
    addMissingArrayIssue(options);
    return false;
  }
  validateArrayEntries(options, options.value);
  return true;
}

function validateRelativeSelector(options: {
  ctx: ConfigValidationContext;
  index: number;
  message: string;
  path: PropertyKey[];
  value: unknown;
}): void {
  if (!isNonEmptyString(options.value)) return;
  if (!isAbsolutePublicSelector(options.value)) return;
  addConfigIssue(
    options.ctx,
    [...options.path, options.index],
    options.message,
  );
}

export function validateRelativeSelectors(options: {
  ctx: ConfigValidationContext;
  message: string;
  path: PropertyKey[];
  values: unknown;
}): void {
  if (!Array.isArray(options.values)) return;
  for (const [index, value] of options.values.entries()) {
    validateRelativeSelector({ ...options, index, value });
  }
}

export function addUnknownFieldIssues(options: {
  allowed: ReadonlySet<string>;
  ctx: ConfigValidationContext;
  message: string;
  path: PropertyKey[];
  value: Record<string, unknown>;
}): void {
  for (const key of Object.keys(options.value)) {
    if (options.allowed.has(key)) continue;
    addConfigIssue(options.ctx, [...options.path, key], options.message);
  }
}
