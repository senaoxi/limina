import {
  addConfigIssue,
  addUnknownFieldIssues,
  type ConfigValidationContext,
  isAbsolutePublicSelector,
  isNonEmptyString,
  isPlainConfigRecord,
} from './shared';

const sourceBoundaryKeys = new Set(['exclude', 'include']);

function addInvalidBoundaryEntry(options: {
  ctx: ConfigValidationContext;
  field: 'exclude' | 'include';
  index: number;
}): void {
  addConfigIssue(
    options.ctx,
    ['source', options.field, options.index],
    `config.source.${options.field} entries must be non-empty strings.`,
  );
}

function addAbsoluteBoundaryEntry(options: {
  ctx: ConfigValidationContext;
  field: 'exclude' | 'include';
  index: number;
}): void {
  addConfigIssue(
    options.ctx,
    ['source', options.field, options.index],
    `config.source.${options.field} entries must be config.rootDir-relative paths; ../ is allowed.`,
  );
}

function validatePresentBoundaryEntry(options: {
  ctx: ConfigValidationContext;
  field: 'exclude' | 'include';
  index: number;
  value: string;
}): boolean {
  if (options.value === '...') return true;
  if (isAbsolutePublicSelector(options.value))
    addAbsoluteBoundaryEntry(options);
  return false;
}

function validateSourceBoundaryEntry(options: {
  ctx: ConfigValidationContext;
  field: 'exclude' | 'include';
  index: number;
  value: unknown;
}): boolean {
  if (!isNonEmptyString(options.value)) {
    addInvalidBoundaryEntry(options);
    return false;
  }
  return validatePresentBoundaryEntry({ ...options, value: options.value });
}

function addBoundaryArrayIssue(options: {
  ctx: ConfigValidationContext;
  field: 'exclude' | 'include';
}): void {
  addConfigIssue(
    options.ctx,
    ['source', options.field],
    `config.source.${options.field} must be a non-empty string array.`,
  );
}

function countDefaultTokens(options: {
  ctx: ConfigValidationContext;
  field: 'exclude' | 'include';
  values: readonly unknown[];
}): number {
  let count = 0;
  for (const [index, value] of options.values.entries()) {
    if (validateSourceBoundaryEntry({ ...options, index, value })) count += 1;
  }
  return count;
}

function isNonEmptyUnknownArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  return value.length > 0;
}

function getBoundaryValues(options: {
  ctx: ConfigValidationContext;
  field: 'exclude' | 'include';
  source: Record<string, unknown>;
}): unknown[] | null {
  const value = options.source[options.field];
  if (value === undefined) return null;
  if (isNonEmptyUnknownArray(value)) return value;
  addBoundaryArrayIssue(options);
  return null;
}

function validateDefaultTokenCount(options: {
  ctx: ConfigValidationContext;
  field: 'exclude' | 'include';
  values: readonly unknown[];
}): void {
  if (countDefaultTokens(options) <= 1) return;
  addConfigIssue(
    options.ctx,
    ['source', options.field],
    `config.source.${options.field} may contain "..." at most once.`,
  );
}

function validateSourceBoundaryField(options: {
  ctx: ConfigValidationContext;
  field: 'exclude' | 'include';
  source: Record<string, unknown>;
}): void {
  const values = getBoundaryValues(options);
  if (values === null) return;
  validateDefaultTokenCount({ ...options, values });
}

export function validateSourceBoundary(
  value: unknown,
  ctx: ConfigValidationContext,
): void {
  if (value === undefined) return;
  if (!isPlainConfigRecord(value)) {
    addConfigIssue(
      ctx,
      ['source'],
      'source boundary config must be an object.',
    );
    return;
  }
  addUnknownFieldIssues({
    allowed: sourceBoundaryKeys,
    ctx,
    message: 'unknown source boundary config field.',
    path: ['source'],
    value,
  });
  validateSourceBoundaryField({ ctx, field: 'include', source: value });
  validateSourceBoundaryField({ ctx, field: 'exclude', source: value });
}
