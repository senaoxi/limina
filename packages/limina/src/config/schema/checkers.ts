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
  ctx: ConfigValidationContext,
  path: PropertyKey[],
  message: string,
): void {
  addConfigIssue(ctx, path, message);
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
  ctx: ConfigValidationContext,
): unknown[] | null {
  const exclude = checkers.exclude;
  if (exclude === undefined) return null;
  if (Array.isArray(exclude)) return exclude;
  addCheckerIssue(
    ctx,
    ['checkers', 'auto', 'exclude'],
    'auto checker exclude must be a string array when configured.',
  );
  return null;
}

function validateAutoExclude(
  checkers: Record<string, unknown>,
  ctx: ConfigValidationContext,
): void {
  const exclude = getAutoExclude(checkers, ctx);
  if (exclude === null) return;
  for (const [index, value] of exclude.entries()) {
    validateAutoExcludeEntry({ ctx, index, value });
  }
}

function validateAutoUseTsgo(
  checkers: Record<string, unknown>,
  ctx: ConfigValidationContext,
): void {
  if (checkers.useTsgo === undefined) return;
  if (typeof checkers.useTsgo === 'boolean') return;
  addCheckerIssue(
    ctx,
    ['checkers', 'auto', 'useTsgo'],
    'auto checker useTsgo must be a boolean when configured.',
  );
}

function validateAutoCheckers(
  checkers: Record<string, unknown>,
  ctx: ConfigValidationContext,
): void {
  validateAutoExclude(checkers, ctx);
  validateAutoUseTsgo(checkers, ctx);
  addUnknownFieldIssues({
    allowed: autoCheckerKeys,
    ctx,
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
  ctx: ConfigValidationContext,
): void {
  if (isPlainConfigRecord(checker)) {
    validateAutoCheckers(checker, ctx);
    return;
  }
  addCheckerIssue(
    ctx,
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
  ctx: ConfigValidationContext,
): void {
  for (const [checkerName, checker] of Object.entries(checkers)) {
    validateCheckerValue({ checker, checkerName, ctx });
  }
}

function validateCheckerRecord(
  value: Record<string, unknown>,
  ctx: ConfigValidationContext,
): void {
  if (Object.hasOwn(value, 'mode')) {
    addCheckerIssue(ctx, ['checkers', 'mode'], legacyAutoCheckerConfigReason);
    return;
  }
  validateNamedCheckers(value, ctx);
}

function validateCheckers(value: unknown, ctx: ConfigValidationContext): void {
  if (value === undefined) return;
  if (!isPlainConfigRecord(value)) {
    addCheckerIssue(ctx, ['checkers'], checkerConfigReason);
    return;
  }
  validateCheckerRecord(value, ctx);
}

export const sharedLiminaConfigShapeSchema: z.ZodType<Record<string, unknown>> =
  z.looseObject({}).superRefine((config, ctx) => {
    validateCheckers(config.checkers, ctx);
    validateImports(config.imports, ctx);
    validateSourceBoundary(config.source, ctx);
  });
