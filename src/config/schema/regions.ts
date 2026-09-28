import {
  addConfigIssue,
  addUnknownFieldIssues,
  type ConfigValidationContext,
  isNonEmptyString,
  isPlainConfigRecord,
  validateRelativeSelectors,
  validateStringArrayField,
} from './shared';

const regionKeys = new Set(['exclude', 'extendNestedPackageScopes']);
const regionEntryKeys = new Set(['include', 'kind', 'reason']);
const regionExcludeKinds = ['workspace-package', 'package-scope'] as const;
type RegionExcludeKind = (typeof regionExcludeKinds)[number];

function isRegionExcludeKind(value: unknown): value is RegionExcludeKind {
  if (typeof value !== 'string') return false;
  return regionExcludeKinds.includes(value as RegionExcludeKind);
}

function validateRegionKind(options: {
  ctx: ConfigValidationContext;
  index: number;
  path: PropertyKey[];
  value: Record<string, unknown>;
}): void {
  if (!Object.hasOwn(options.value, 'kind')) {
    addConfigIssue(
      options.ctx,
      [...options.path, 'kind'],
      `regions.exclude[${options.index}].kind is required.`,
    );
    return;
  }
  if (isRegionExcludeKind(options.value.kind)) return;
  addConfigIssue(
    options.ctx,
    [...options.path, 'kind'],
    [
      `regions.exclude[${options.index}].kind must be one of:`,
      ...regionExcludeKinds.map((kind) => `  ${kind}`),
    ].join('\n'),
  );
}

function validateRegionIncludes(options: {
  ctx: ConfigValidationContext;
  path: PropertyKey[];
  value: Record<string, unknown>;
}): void {
  const includePath = [...options.path, 'include'];
  validateStringArrayField({
    ctx: options.ctx,
    path: includePath,
    required: true,
    value: options.value.include,
    valueName: 'regions.exclude.include',
  });
  validateRelativeSelectors({
    ctx: options.ctx,
    message:
      'regions.exclude.include entries must be config.rootDir-relative paths; ../ is allowed.',
    path: includePath,
    values: options.value.include,
  });
}

function validateRegionReason(options: {
  ctx: ConfigValidationContext;
  path: PropertyKey[];
  value: Record<string, unknown>;
}): void {
  if (isNonEmptyString(options.value.reason)) return;
  addConfigIssue(
    options.ctx,
    [...options.path, 'reason'],
    'reason must be a non-empty string.',
  );
}

function validateRegionEntry(options: {
  ctx: ConfigValidationContext;
  index: number;
  value: unknown;
}): void {
  const path = ['regions', 'exclude', options.index];
  if (!isPlainConfigRecord(options.value)) {
    addConfigIssue(
      options.ctx,
      path,
      'regions.exclude entries must be objects with kind, include, and reason fields.',
    );
    return;
  }
  addUnknownFieldIssues({
    allowed: regionEntryKeys,
    ctx: options.ctx,
    message: 'unknown regions.exclude entry field.',
    path,
    value: options.value,
  });
  const entryOptions = {
    ctx: options.ctx,
    index: options.index,
    path,
    value: options.value,
  };
  validateRegionKind(entryOptions);
  validateRegionIncludes(entryOptions);
  validateRegionReason(entryOptions);
}

function getRegionExclusions(
  value: unknown,
  ctx: ConfigValidationContext,
): unknown[] | null {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value;
  addConfigIssue(
    ctx,
    ['regions', 'exclude'],
    'regions.exclude must be an array.',
  );
  return null;
}

function validateRegionExclusions(
  value: unknown,
  ctx: ConfigValidationContext,
): void {
  const exclusions = getRegionExclusions(value, ctx);
  if (exclusions === null) return;
  for (const [index, entry] of exclusions.entries()) {
    validateRegionEntry({ ctx, index, value: entry });
  }
}

function validateNestedPackageScopeFlag(
  value: unknown,
  ctx: ConfigValidationContext,
): void {
  if (value === undefined || typeof value === 'boolean') return;
  addConfigIssue(
    ctx,
    ['regions', 'extendNestedPackageScopes'],
    'regions.extendNestedPackageScopes must be a boolean.',
  );
}

export function validateRegionsConfig(
  value: unknown,
  ctx: ConfigValidationContext,
): void {
  if (value === undefined) return;
  if (!isPlainConfigRecord(value)) {
    addConfigIssue(ctx, ['regions'], 'regions config must be an object.');
    return;
  }
  addUnknownFieldIssues({
    allowed: regionKeys,
    ctx,
    message: 'unknown regions config field.',
    path: ['regions'],
    value,
  });
  validateNestedPackageScopeFlag(value.extendNestedPackageScopes, ctx);
  validateRegionExclusions(value.exclude, ctx);
}
