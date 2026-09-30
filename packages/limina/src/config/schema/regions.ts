import {
  addConfigIssue,
  addUnknownFieldIssues,
  type ConfigValidationContext,
  isNonEmptyString,
  isPlainConfigRecord,
  isValidateStringArrayField,
  validateRelativeSelectors,
} from './shared';

const regionKeys = new Set(['exclude', 'extendNestedPackageScopes']);
const regionEntryKeys = new Set(['include', 'kind', 'reason']);
const regionExcludeKinds = [
  'workspace-package',
  'package-scope',
  'tsconfig',
] as const;
type RegionExcludeKind = (typeof regionExcludeKinds)[number];

function isRegionExcludeKind(value: unknown): value is RegionExcludeKind {
  return (
    typeof value === 'string' &&
    regionExcludeKinds.includes(value as RegionExcludeKind)
  );
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
  isValidateStringArrayField({
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
  validateExactTsconfigSelectors(entryOptions);
  validateRegionReason(entryOptions);
}

function getRegionExclusions(
  value: unknown,
  context: ConfigValidationContext,
): unknown[] | null {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value;
  addConfigIssue(
    context,
    ['regions', 'exclude'],
    'regions.exclude must be an array.',
  );
  return null;
}

function validateRegionExclusions(
  value: unknown,
  context: ConfigValidationContext,
): void {
  const exclusions = getRegionExclusions(value, context);
  if (exclusions === null) return;
  for (const [index, entry] of exclusions.entries()) {
    validateRegionEntry({ ctx: context, index, value: entry });
  }
}

function validateNestedPackageScopeFlag(
  value: unknown,
  context: ConfigValidationContext,
): void {
  if (value === undefined || typeof value === 'boolean') return;
  addConfigIssue(
    context,
    ['regions', 'extendNestedPackageScopes'],
    'regions.extendNestedPackageScopes must be a boolean.',
  );
}

export function validateRegionsConfig(
  value: unknown,
  context: ConfigValidationContext,
): void {
  if (value === undefined) return;
  if (!isPlainConfigRecord(value)) {
    addConfigIssue(context, ['regions'], 'regions config must be an object.');
    return;
  }
  addUnknownFieldIssues({
    allowed: regionKeys,
    ctx: context,
    message: 'unknown regions config field.',
    path: ['regions'],
    value,
  });
  validateNestedPackageScopeFlag(value.extendNestedPackageScopes, context);
  validateRegionExclusions(value.exclude, context);
}

function isInvalidExactTsconfigPath(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (/[*?{}]/u.test(value) ||
      !/(?:^|[\\/])tsconfig(?:\.[^\\/]+)?\.json$/u.test(value))
  );
}
function validateExactTsconfigSelectors(options: {
  ctx: ConfigValidationContext;
  path: PropertyKey[];
  value: Record<string, unknown>;
}): void {
  if (
    options.value.kind !== 'tsconfig' ||
    !Array.isArray(options.value.include)
  )
    return;
  addExactSelectorIssues(options, options.value.include);
}
function addExactSelectorIssues(
  options: { ctx: ConfigValidationContext; path: PropertyKey[] },
  values: unknown[],
): void {
  for (const [index, value] of values.entries()) {
    if (isInvalidExactTsconfigPath(value))
      addConfigIssue(
        options.ctx,
        [...options.path, 'include', index],
        'tsconfig exclusions require exact tsconfig.json or tsconfig.*.json file paths, not directory or glob selectors.',
      );
  }
}
