import { z } from 'zod';
import type { ExecutionConfig } from '../../execution/config';
import {
  addConfigIssue,
  addUnknownFieldIssues,
  type ConfigValidationContext,
  isNonEmptyString,
  isPlainConfigRecord,
} from './shared';

function isBaselineTag(value: unknown): boolean {
  return typeof value === 'function' || isNonEmptyString(value);
}

function validateBaselineTag(
  value: unknown,
  context: ConfigValidationContext,
): void {
  if (value === undefined || isBaselineTag(value)) return;
  addConfigIssue(
    context,
    ['baselineTag'],
    'baselineTag must be a non-empty string or function.',
  );
}

function validateBuiltinIgnore(
  value: unknown,
  context: ConfigValidationContext,
): void {
  if (value === undefined || typeof value === 'boolean') return;
  addConfigIssue(
    context,
    ['builtinIgnore'],
    'builtinIgnore must be a boolean.',
  );
}

function validateIgnorePattern(options: {
  ctx: ConfigValidationContext;
  index: number;
  value: unknown;
}): void {
  if (isNonEmptyString(options.value)) return;
  addConfigIssue(
    options.ctx,
    ['ignore', options.index],
    'ignore patterns must be non-empty strings.',
  );
}

function isDeferredIgnore(value: unknown): boolean {
  return value === undefined || typeof value === 'function';
}

function validateIgnorePatterns(
  values: readonly unknown[],
  context: ConfigValidationContext,
): void {
  for (const [index, pattern] of values.entries()) {
    validateIgnorePattern({ ctx: context, index, value: pattern });
  }
}

function validateContentHashIgnore(
  value: unknown,
  context: ConfigValidationContext,
): void {
  if (isDeferredIgnore(value)) return;
  if (Array.isArray(value)) {
    validateIgnorePatterns(value, context);
    return;
  }
  addConfigIssue(
    context,
    ['ignore'],
    'ignore must be an array of non-empty strings or function.',
  );
}

export const releaseContentHashShapeSchema: z.ZodType<Record<string, unknown>> =
  z.looseObject({}).superRefine((contentHash, context) => {
    validateBaselineTag(contentHash.baselineTag, context);
    validateBuiltinIgnore(contentHash.builtinIgnore, context);
    validateContentHashIgnore(contentHash.ignore, context);
  });

const releaseNpmPackageJsonLintSeverities = new Set([
  'error',
  'off',
  'warning',
]);
const npmPackageJsonLintKeys = new Set(['rules']);

function isRuleSeverity(value: unknown): value is string {
  return (
    typeof value === 'string' && releaseNpmPackageJsonLintSeverities.has(value)
  );
}

function isRuleOptions(value: unknown): boolean {
  return Array.isArray(value) || isPlainConfigRecord(value);
}

function isRuleTupleShape(
  value: unknown,
): value is readonly [unknown, unknown] {
  return Array.isArray(value) && value.length === 2;
}

function isRuleTuple(value: unknown): boolean {
  return (
    isRuleTupleShape(value) &&
    isRuleSeverity(value[0]) &&
    isRuleOptions(value[1])
  );
}

function isReleaseNpmPackageJsonLintRuleConfig(value: unknown): boolean {
  return isRuleSeverity(value) || isRuleTuple(value);
}

function isValidateRuleName(options: {
  ctx: ConfigValidationContext;
  name: string;
}): boolean {
  if (options.name.trim().length > 0) return true;
  addConfigIssue(
    options.ctx,
    ['rules'],
    'npmPackageJsonLint rule names must be non-empty strings.',
  );
  return false;
}

function validateRuleConfig(options: {
  ctx: ConfigValidationContext;
  name: string;
  value: unknown;
}): void {
  if (
    !isValidateRuleName(options) ||
    isReleaseNpmPackageJsonLintRuleConfig(options.value)
  )
    return;
  addConfigIssue(
    options.ctx,
    ['rules', options.name],
    'rule config must be "off", "warning", "error", or a [severity, options] tuple.',
  );
}

function getRuleRecord(
  value: unknown,
  context: ConfigValidationContext,
): Record<string, unknown> | null {
  if (value === undefined) return null;
  if (isPlainConfigRecord(value)) return value;
  addConfigIssue(
    context,
    ['rules'],
    'npmPackageJsonLint.rules must be an object.',
  );
  return null;
}

function validateNpmPackageJsonLintRules(
  value: unknown,
  context: ConfigValidationContext,
): void {
  const rules = getRuleRecord(value, context);
  if (rules === null) return;
  for (const [name, ruleConfig] of Object.entries(rules)) {
    validateRuleConfig({ ctx: context, name, value: ruleConfig });
  }
}

export const releaseNpmPackageJsonLintShapeSchema: z.ZodType<unknown> = z
  .unknown()
  .superRefine((value, context) => {
    if (typeof value === 'boolean') return;
    if (!isPlainConfigRecord(value)) {
      addConfigIssue(
        context,
        [],
        'npmPackageJsonLint must be a boolean or object.',
      );
      return;
    }
    addUnknownFieldIssues({
      allowed: npmPackageJsonLintKeys,
      ctx: context,
      message: 'unknown npmPackageJsonLint config field.',
      path: [],
      value,
    });
    validateNpmPackageJsonLintRules(value.rules, context);
  });

export const releaseConfigShapeSchema: z.ZodType<Record<string, unknown>> =
  z.looseObject({
    contentHash: releaseContentHashShapeSchema.optional(),
    npmPackageJsonLint: releaseNpmPackageJsonLintShapeSchema.optional(),
  });

const executionConcurrencyError =
  'execution concurrency must be a positive integer or "auto".';
const executionConcurrencySchema = z.union(
  [
    z.literal('auto', { error: executionConcurrencyError }),
    z
      .number({ error: executionConcurrencyError })
      .int({ error: executionConcurrencyError })
      .positive({ error: executionConcurrencyError }),
  ],
  { error: executionConcurrencyError },
);

type ExecutionConfigShape = {
  [Key in keyof ExecutionConfig]-?: z.ZodType<ExecutionConfig[Key]>;
};

const executionConfigShape = {
  checkerBuild: executionConcurrencySchema.optional(),
  checkerTypecheck: executionConcurrencySchema.optional(),
  packageEntries: executionConcurrencySchema.optional(),
  releaseEntries: executionConcurrencySchema.optional(),
  tasks: executionConcurrencySchema.optional(),
} satisfies ExecutionConfigShape;

const executionConfigKeys = new Set(Object.keys(executionConfigShape));

export const executionConfigShapeSchema: z.ZodType<Record<string, unknown>> = z
  .looseObject(executionConfigShape)
  .superRefine((execution, context) => {
    addUnknownFieldIssues({
      allowed: executionConfigKeys,
      ctx: context,
      message: 'unknown execution config field.',
      path: [],
      value: execution,
    });
  });
