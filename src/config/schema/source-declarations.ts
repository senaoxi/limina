import {
  addConfigIssue,
  addUnknownFieldIssues,
  type ConfigValidationContext,
  isNonEmptyString,
  isPlainConfigRecord,
  validateRelativeSelectors,
  validateStringArrayField,
} from './shared';

const declarationsKeys = new Set(['ambient']);
const ambientRuleKeys = new Set([
  'allowSharedAcrossOwners',
  'allowTripleSlashReferences',
  'include',
  'reason',
]);
const declarationsPath = ['source', 'declarations'] as const;

function validateBooleanField(options: {
  ctx: ConfigValidationContext;
  path: PropertyKey[];
  value: unknown;
}): void {
  if (options.value === undefined || typeof options.value === 'boolean') return;
  const key = String(options.path.at(-1));
  addConfigIssue(options.ctx, options.path, `${key} must be a boolean.`);
}

function validateAmbientRuleFields(options: {
  ctx: ConfigValidationContext;
  path: PropertyKey[];
  rule: Record<string, unknown>;
}): void {
  addUnknownFieldIssues({
    allowed: ambientRuleKeys,
    ctx: options.ctx,
    message: 'unknown ambient declaration rule field.',
    path: options.path,
    value: options.rule,
  });
}

function validateAmbientIncludes(options: {
  ctx: ConfigValidationContext;
  path: PropertyKey[];
  rule: Record<string, unknown>;
}): void {
  const includePath = [...options.path, 'include'];
  validateStringArrayField({
    ctx: options.ctx,
    path: includePath,
    required: true,
    value: options.rule.include,
    valueName: 'ambient declaration include',
  });
  validateRelativeSelectors({
    ctx: options.ctx,
    message:
      'ambient declaration include entries must be config.rootDir-relative paths; ../ is allowed.',
    path: includePath,
    values: options.rule.include,
  });
}

function validateAmbientReason(options: {
  ctx: ConfigValidationContext;
  path: PropertyKey[];
  rule: Record<string, unknown>;
}): void {
  if (isNonEmptyString(options.rule.reason)) return;
  addConfigIssue(
    options.ctx,
    [...options.path, 'reason'],
    'ambient declaration reason must be a non-empty string.',
  );
}

function validateAmbientBooleans(options: {
  ctx: ConfigValidationContext;
  path: PropertyKey[];
  rule: Record<string, unknown>;
}): void {
  validateBooleanField({
    ctx: options.ctx,
    path: [...options.path, 'allowSharedAcrossOwners'],
    value: options.rule.allowSharedAcrossOwners,
  });
  validateBooleanField({
    ctx: options.ctx,
    path: [...options.path, 'allowTripleSlashReferences'],
    value: options.rule.allowTripleSlashReferences,
  });
}

function validateAmbientRule(options: {
  ctx: ConfigValidationContext;
  index: number;
  value: unknown;
}): void {
  const path = [...declarationsPath, 'ambient', options.index];
  if (!isPlainConfigRecord(options.value)) {
    addConfigIssue(
      options.ctx,
      path,
      'ambient declaration rules must be objects.',
    );
    return;
  }
  const ruleOptions = { ctx: options.ctx, path, rule: options.value };
  validateAmbientRuleFields(ruleOptions);
  validateAmbientIncludes(ruleOptions);
  validateAmbientReason(ruleOptions);
  validateAmbientBooleans(ruleOptions);
}

function getAmbientRules(
  value: unknown,
  ctx: ConfigValidationContext,
): unknown[] | null {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value;
  addConfigIssue(
    ctx,
    [...declarationsPath, 'ambient'],
    'ambient must be an array.',
  );
  return null;
}

function validateAmbientRules(
  value: unknown,
  ctx: ConfigValidationContext,
): void {
  const rules = getAmbientRules(value, ctx);
  if (rules === null) return;
  for (const [index, rule] of rules.entries()) {
    validateAmbientRule({ ctx, index, value: rule });
  }
}

export function validateSourceDeclarationsConfig(
  value: unknown,
  ctx: ConfigValidationContext,
): void {
  if (value === undefined) return;
  if (!isPlainConfigRecord(value)) {
    addConfigIssue(
      ctx,
      [...declarationsPath],
      'declarations must be an object.',
    );
    return;
  }
  addUnknownFieldIssues({
    allowed: declarationsKeys,
    ctx,
    message: 'unknown source declarations config field.',
    path: [...declarationsPath],
    value,
  });
  validateAmbientRules(value.ambient, ctx);
}
