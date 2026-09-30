import { z } from 'zod';
import {
  autoCheckerKeys,
  checkerNames,
  legacyAutoCheckerConfigReason,
  unsupportedCheckerNameReason,
} from './checker-schema-constants';
import { checkerConfigShapeSchema } from './checker-scope-schema';
import { validateImports } from './imports';
import {
  addConfigIssue,
  addUnknownFieldIssues,
  type ConfigValidationContext,
  isAbsolutePublicSelector,
  isNonEmptyString,
  isPlainConfigRecord,
} from './shared';
import { validateSourceBoundary } from './source-boundary';

export {
  legacyAutoCheckerConfigReason,
  unsupportedCheckerNameReason,
} from './checker-schema-constants';
export { checkerConfigShapeSchema } from './checker-scope-schema';

const checkerConfigReason =
  'config.checkers must be an object keyed by auto or checker name.';

function addCheckerIssue(
  context: ConfigValidationContext,
  path: PropertyKey[],
  message: string,
): void {
  addConfigIssue(context, path, message);
}

function validateAutoExcludeEntry(options: {
  ctx: ConfigValidationContext;
  index: number;
  value: unknown;
}): void {
  if (!isNonEmptyString(options.value)) {
    addCheckerIssue(
      options.ctx,
      ['checkers', 'auto', 'exclude', options.index],
      'auto checker exclude entries must be non-empty string paths.',
    );
    return;
  }
  if (!isAbsolutePublicSelector(options.value)) return;
  addCheckerIssue(
    options.ctx,
    ['checkers', 'auto', 'exclude', options.index],
    'auto checker exclude entries must be config.rootDir-relative paths; ../ is allowed.',
  );
}

function getAutoExclude(
  checkers: Record<string, unknown>,
  context: ConfigValidationContext,
): unknown[] | null {
  const exclude = checkers.exclude;
  if (exclude === undefined) return null;
  if (Array.isArray(exclude)) return exclude;
  addCheckerIssue(
    context,
    ['checkers', 'auto', 'exclude'],
    'auto checker exclude must be a string array when configured.',
  );
  return null;
}

function validateAutoExclude(
  checkers: Record<string, unknown>,
  context: ConfigValidationContext,
): void {
  const exclude = getAutoExclude(checkers, context);
  if (exclude === null) return;
  for (const [index, value] of exclude.entries()) {
    validateAutoExcludeEntry({ ctx: context, index, value });
  }
}

function validateAutoUseTsgo(
  checkers: Record<string, unknown>,
  context: ConfigValidationContext,
): void {
  if (checkers.useTsgo === undefined || typeof checkers.useTsgo === 'boolean')
    return;
  addCheckerIssue(
    context,
    ['checkers', 'auto', 'useTsgo'],
    'auto checker useTsgo must be a boolean when configured.',
  );
}

function validateAutoCheckers(
  checkers: Record<string, unknown>,
  context: ConfigValidationContext,
): void {
  validateAutoExclude(checkers, context);
  validateAutoUseTsgo(checkers, context);
  addUnknownFieldIssues({
    allowed: autoCheckerKeys,
    ctx: context,
    message: 'unknown auto checker config field.',
    path: ['checkers', 'auto'],
    value: checkers,
  });
}

function addNamedCheckerIssues(options: {
  checker: unknown;
  checkerName: string;
  ctx: ConfigValidationContext;
}): void {
  const result = checkerConfigShapeSchema.safeParse(options.checker);
  if (result.success) return;
  for (const issue of result.error.issues) {
    addConfigIssue(
      options.ctx,
      ['checkers', options.checkerName, ...issue.path],
      issue.message,
    );
  }
}

function validateNamedChecker(options: {
  checker: unknown;
  checkerName: string;
  ctx: ConfigValidationContext;
}): void {
  if (checkerNames.has(options.checkerName)) {
    addNamedCheckerIssues(options);
    return;
  }
  addCheckerIssue(
    options.ctx,
    ['checkers', options.checkerName],
    unsupportedCheckerNameReason,
  );
}

function validateAutoCheckerValue(
  checker: unknown,
  context: ConfigValidationContext,
): void {
  if (isPlainConfigRecord(checker)) {
    validateAutoCheckers(checker, context);
    return;
  }
  addCheckerIssue(
    context,
    ['checkers', 'auto'],
    'config.checkers.auto must be an object when configured.',
  );
}

function validateCheckerValue(options: {
  checker: unknown;
  checkerName: string;
  ctx: ConfigValidationContext;
}): void {
  if (options.checkerName === 'auto') {
    validateAutoCheckerValue(options.checker, options.ctx);
    return;
  }
  validateNamedChecker(options);
}

function validateNamedCheckers(
  checkers: Record<string, unknown>,
  context: ConfigValidationContext,
): void {
  for (const [checkerName, checker] of Object.entries(checkers)) {
    validateCheckerValue({ checker, checkerName, ctx: context });
  }
}

function validateCheckerRecord(
  value: Record<string, unknown>,
  context: ConfigValidationContext,
): void {
  if (Object.hasOwn(value, 'mode')) {
    addCheckerIssue(
      context,
      ['checkers', 'mode'],
      legacyAutoCheckerConfigReason,
    );
    return;
  }
  validateNamedCheckers(value, context);
}

function validateCheckers(
  value: unknown,
  context: ConfigValidationContext,
): void {
  if (value === undefined) return;
  if (!isPlainConfigRecord(value)) {
    addCheckerIssue(context, ['checkers'], checkerConfigReason);
    return;
  }
  validateCheckerRecord(value, context);
}

export const sharedLiminaConfigShapeSchema: z.ZodType<Record<string, unknown>> =
  z.looseObject({}).superRefine((config, context) => {
    validateCheckers(config.checkers, context);
    validateImports(config.imports, context);
    validateSourceBoundary(config.source, context);
  });
