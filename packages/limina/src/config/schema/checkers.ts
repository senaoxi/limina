import { getCheckerAdapter } from '#checkers';
import { z } from 'zod';
import { validateImports } from './imports';
import {
  addConfigIssue,
  addUnknownFieldIssues,
  type ConfigValidationContext,
  isAbsolutePublicSelector,
  isNonEmptyString,
  isPathSafeIdentifier,
  isPlainConfigRecord,
} from './shared';
import { validateSourceBoundary } from './source-boundary';

export const unsupportedCheckerPresetReason =
  'configured checkers require a built-in checker adapter.';
export const autoCheckerMixedConfigReason =
  'auto checker config must not be mixed with named checker entries.';

const checkerConfigReason =
  'config.checkers must be an object auto config or an object keyed by checker name.';
const autoCheckerModeConfigReason =
  'auto checker config requires mode: "auto".';
const checkerConfigKeys = new Set(['exclude', 'include', 'preset']);
const autoCheckerKeys = new Set(['exclude', 'mode']);

function addCheckerIssue(
  ctx: ConfigValidationContext,
  path: PropertyKey[],
  message: string,
): void {
  addConfigIssue(ctx, path, message);
}

function validateCheckerPreset(
  checker: Record<string, unknown>,
  ctx: ConfigValidationContext,
): void {
  if (!isNonEmptyString(checker.preset)) {
    addCheckerIssue(
      ctx,
      ['preset'],
      'checker preset must be a non-empty string.',
    );
    return;
  }
  if (getCheckerAdapter(checker.preset) !== null) return;
  addCheckerIssue(ctx, ['preset'], unsupportedCheckerPresetReason);
}

function validateCheckerSelectorEntry(options: {
  ctx: ConfigValidationContext;
  field: 'exclude' | 'include';
  index: number;
  value: unknown;
}): void {
  if (!isNonEmptyString(options.value)) {
    addCheckerIssue(
      options.ctx,
      [options.field, options.index],
      `checker ${options.field} entries must be non-empty string paths.`,
    );
    return;
  }
  if (!isAbsolutePublicSelector(options.value)) return;
  addCheckerIssue(
    options.ctx,
    [options.field, options.index],
    `checker ${options.field} entries must be config.rootDir-relative paths; ../ is allowed.`,
  );
}

function handleMissingSelector(options: {
  ctx: ConfigValidationContext;
  field: 'exclude' | 'include';
  required: boolean;
}): null {
  if (!options.required) return null;
  addCheckerIssue(
    options.ctx,
    [options.field],
    `checker ${options.field} must be a non-empty string array.`,
  );
  return null;
}

function validateSelectorArrayShape(options: {
  ctx: ConfigValidationContext;
  field: 'exclude' | 'include';
  required: boolean;
  value: unknown[];
}): unknown[] | null {
  if (!options.required || options.value.length > 0) return options.value;
  addCheckerIssue(
    options.ctx,
    [options.field],
    'checker include must be a non-empty string array.',
  );
  return null;
}

function getCheckerSelectorArray(options: {
  checker: Record<string, unknown>;
  ctx: ConfigValidationContext;
  field: 'exclude' | 'include';
  required: boolean;
}): unknown[] | null {
  const value = options.checker[options.field];
  if (value === undefined) return handleMissingSelector(options);
  if (Array.isArray(value))
    return validateSelectorArrayShape({ ...options, value });
  addCheckerIssue(
    options.ctx,
    [options.field],
    `checker ${options.field} must be a string array when configured.`,
  );
  return null;
}

function validateCheckerSelectorArray(options: {
  checker: Record<string, unknown>;
  ctx: ConfigValidationContext;
  field: 'exclude' | 'include';
  required: boolean;
}): void {
  const values = getCheckerSelectorArray(options);
  if (values === null) return;
  for (const [index, value] of values.entries()) {
    validateCheckerSelectorEntry({
      ctx: options.ctx,
      field: options.field,
      index,
      value,
    });
  }
}

export const checkerConfigShapeSchema: z.ZodType<Record<string, unknown>> = z
  .looseObject({})
  .superRefine((checker, ctx) => {
    addUnknownFieldIssues({
      allowed: checkerConfigKeys,
      ctx,
      message: 'unknown checker config field.',
      path: [],
      value: checker,
    });
    validateCheckerPreset(checker, ctx);
    validateCheckerSelectorArray({
      checker,
      ctx,
      field: 'include',
      required: true,
    });
    validateCheckerSelectorArray({
      checker,
      ctx,
      field: 'exclude',
      required: false,
    });
  });

function validateAutoExcludeEntry(options: {
  ctx: ConfigValidationContext;
  index: number;
  value: unknown;
}): void {
  if (!isNonEmptyString(options.value)) {
    addCheckerIssue(
      options.ctx,
      ['checkers', 'exclude', options.index],
      'auto checker exclude entries must be non-empty string paths.',
    );
    return;
  }
  if (!isAbsolutePublicSelector(options.value)) return;
  addCheckerIssue(
    options.ctx,
    ['checkers', 'exclude', options.index],
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
    ['checkers', 'exclude'],
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

function validateAutoCheckers(
  checkers: Record<string, unknown>,
  ctx: ConfigValidationContext,
): void {
  if (checkers.mode !== 'auto') {
    addCheckerIssue(ctx, ['checkers', 'mode'], autoCheckerModeConfigReason);
  }
  validateAutoExclude(checkers, ctx);
  addUnknownFieldIssues({
    allowed: autoCheckerKeys,
    ctx,
    message: autoCheckerMixedConfigReason,
    path: ['checkers'],
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

function validateNamedCheckers(
  checkers: Record<string, unknown>,
  ctx: ConfigValidationContext,
): void {
  for (const [checkerName, checker] of Object.entries(checkers)) {
    if (!isPathSafeIdentifier(checkerName)) {
      addCheckerIssue(
        ctx,
        ['checkers', checkerName],
        'checker names must be non-empty path-safe identifiers without slash segments.',
      );
      continue;
    }
    addNamedCheckerIssues({ checker, checkerName, ctx });
  }
}

function validateCheckerRecord(
  value: Record<string, unknown>,
  ctx: ConfigValidationContext,
): void {
  if (Object.hasOwn(value, 'mode')) validateAutoCheckers(value, ctx);
  else validateNamedCheckers(value, ctx);
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
